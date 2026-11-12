#include <android/log.h>
#include <jni.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "llama.h"

#define TAG "WordVaultLLM"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace {

struct Engine {
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    const llama_vocab * vocab = nullptr;
    std::mutex mutex;
    std::atomic<bool> cancel{false};
    int n_ctx = 4096;
};

struct LoadProgress {
    JNIEnv * env = nullptr;
    jobject callback = nullptr;
    jmethodID method = nullptr;
};

/** 返回字符串中合法 UTF-8 前缀的字节数，用于避免多字节字符被 token 截断时输出乱码 */
size_t valid_utf8_prefix(const std::string & text) {
    size_t i = 0;
    const size_t n = text.size();
    while (i < n) {
        const unsigned char c = static_cast<unsigned char>(text[i]);
        size_t need = 0;
        if (c < 0x80) {
            need = 0;
        } else if ((c & 0xE0) == 0xC0) {
            need = 1;
        } else if ((c & 0xF0) == 0xE0) {
            need = 2;
        } else if ((c & 0xF8) == 0xF0) {
            need = 3;
        } else {
            return i;
        }
        if (i + need >= n) break;
        bool ok = true;
        for (size_t k = 1; k <= need; k += 1) {
            if ((static_cast<unsigned char>(text[i + k]) & 0xC0) != 0x80) {
                ok = false;
                break;
            }
        }
        if (!ok) return i;
        i += need + 1;
    }
    return i;
}

jstring utf8_to_jstring(JNIEnv * env, const std::string & text) {
    jbyteArray bytes = env->NewByteArray(static_cast<jsize>(text.size()));
    if (bytes == nullptr) return nullptr;
    env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(text.size()),
                            reinterpret_cast<const jbyte *>(text.data()));
    jclass str_cls = env->FindClass("java/lang/String");
    jmethodID ctor = env->GetMethodID(str_cls, "<init>", "([BLjava/lang/String;)V");
    jstring charset = env->NewStringUTF("UTF-8");
    jstring result = static_cast<jstring>(env->NewObject(str_cls, ctor, bytes, charset));
    env->DeleteLocalRef(charset);
    env->DeleteLocalRef(bytes);
    return result;
}

bool load_progress_callback(float progress, void * user_data) {
    auto * data = static_cast<LoadProgress *>(user_data);
    if (data == nullptr || data->env == nullptr || data->callback == nullptr) return true;
    data->env->CallVoidMethod(data->callback, data->method, static_cast<jfloat>(progress));
    return true;
}

std::string build_prompt(Engine * engine,
                         const std::vector<std::string> & roles,
                         const std::vector<std::string> & contents) {
    const size_t n_msg = roles.size();
    std::vector<llama_chat_message> chat(n_msg);
    for (size_t i = 0; i < n_msg; i += 1) {
        chat[i].role = roles[i].c_str();
        chat[i].content = contents[i].c_str();
    }

    const char * tmpl = llama_model_chat_template(engine->model, nullptr);
    if (tmpl == nullptr) {
        // 模型未内置模板时退化为 ChatML
        tmpl = "chatml";
    }

    std::vector<char> buf(4096);
    int32_t needed = llama_chat_apply_template(tmpl, chat.data(), n_msg, true, buf.data(),
                                               static_cast<int32_t>(buf.size()));
    if (needed > static_cast<int32_t>(buf.size())) {
        buf.resize(static_cast<size_t>(needed) + 1);
        needed = llama_chat_apply_template(tmpl, chat.data(), n_msg, true, buf.data(),
                                           static_cast<int32_t>(buf.size()));
    }
    if (needed <= 0) return contents.empty() ? std::string() : contents.back();
    return std::string(buf.data(), static_cast<size_t>(needed));
}

std::vector<llama_token> tokenize(const llama_vocab * vocab, const std::string & text) {
    int32_t n = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()), nullptr, 0,
                              false, true);
    if (n < 0) n = -n;
    if (n == 0) return {};
    std::vector<llama_token> tokens(static_cast<size_t>(n));
    const int32_t written = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()),
                                           tokens.data(), n, false, true);
    if (written < 0) return {};
    tokens.resize(static_cast<size_t>(written));
    return tokens;
}

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_wordvault_app_LlmEngine_nativeSystemInfo(JNIEnv * env, jclass) {
    return env->NewStringUTF(llama_print_system_info());
}

JNIEXPORT jlong JNICALL
Java_com_wordvault_app_LlmEngine_nativeLoadModel(JNIEnv * env, jclass, jstring jpath, jint n_ctx,
                                                 jint n_threads, jobject progress_cb) {
    const char * path = env->GetStringUTFChars(jpath, nullptr);
    LOGI("loading model: %s", path);

    static std::once_flag backend_once;
    std::call_once(backend_once, []() { llama_backend_init(); });

    auto * engine = new Engine();
    engine->n_ctx = n_ctx > 0 ? n_ctx : 4096;

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = 0;

    LoadProgress progress;
    if (progress_cb != nullptr) {
        progress.env = env;
        progress.callback = progress_cb;
        jclass cls = env->GetObjectClass(progress_cb);
        progress.method = env->GetMethodID(cls, "onProgress", "(F)V");
        if (progress.method != nullptr) {
            mparams.progress_callback = load_progress_callback;
            mparams.progress_callback_user_data = &progress;
        }
    }

    engine->model = llama_model_load_from_file(path, mparams);
    env->ReleaseStringUTFChars(jpath, path);

    if (engine->model == nullptr) {
        LOGE("failed to load model");
        delete engine;
        return 0;
    }

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = static_cast<uint32_t>(engine->n_ctx);
    cparams.n_batch = 512;
    cparams.n_threads = n_threads > 0 ? n_threads : 4;
    cparams.n_threads_batch = cparams.n_threads;
    cparams.no_perf = true;

    engine->ctx = llama_init_from_model(engine->model, cparams);
    if (engine->ctx == nullptr) {
        LOGE("failed to create context");
        llama_model_free(engine->model);
        delete engine;
        return 0;
    }

    engine->vocab = llama_model_get_vocab(engine->model);
    LOGI("model ready, n_ctx=%d", engine->n_ctx);
    return reinterpret_cast<jlong>(engine);
}

JNIEXPORT void JNICALL
Java_com_wordvault_app_LlmEngine_nativeFreeModel(JNIEnv *, jclass, jlong handle) {
    auto * engine = reinterpret_cast<Engine *>(handle);
    if (engine == nullptr) return;
    std::lock_guard<std::mutex> lock(engine->mutex);
    if (engine->ctx != nullptr) llama_free(engine->ctx);
    if (engine->model != nullptr) llama_model_free(engine->model);
    delete engine;
}

JNIEXPORT void JNICALL
Java_com_wordvault_app_LlmEngine_nativeCancel(JNIEnv *, jclass, jlong handle) {
    auto * engine = reinterpret_cast<Engine *>(handle);
    if (engine == nullptr) return;
    engine->cancel.store(true);
}

/**
 * 流式生成。roles / contents 为等长的对话消息数组，回调对象需实现 void onToken(String)。
 * 返回 true 表示正常结束，false 表示被取消或发生错误。
 */
JNIEXPORT jboolean JNICALL
Java_com_wordvault_app_LlmEngine_nativeGenerate(JNIEnv * env, jclass, jlong handle,
                                                jobjectArray roles, jobjectArray contents,
                                                jint max_tokens, jfloat temperature,
                                                jfloat top_p, jint top_k, jobject callback) {
    auto * engine = reinterpret_cast<Engine *>(handle);
    if (engine == nullptr || engine->ctx == nullptr) return JNI_FALSE;

    std::lock_guard<std::mutex> lock(engine->mutex);
    engine->cancel.store(false);

    const jsize n_msg = env->GetArrayLength(roles);
    std::vector<std::string> role_list;
    std::vector<std::string> content_list;
    role_list.reserve(static_cast<size_t>(n_msg));
    content_list.reserve(static_cast<size_t>(n_msg));
    for (jsize i = 0; i < n_msg; i += 1) {
        auto jr = static_cast<jstring>(env->GetObjectArrayElement(roles, i));
        auto jc = static_cast<jstring>(env->GetObjectArrayElement(contents, i));
        const char * r = env->GetStringUTFChars(jr, nullptr);
        const char * c = env->GetStringUTFChars(jc, nullptr);
        role_list.emplace_back(r);
        content_list.emplace_back(c);
        env->ReleaseStringUTFChars(jr, r);
        env->ReleaseStringUTFChars(jc, c);
        env->DeleteLocalRef(jr);
        env->DeleteLocalRef(jc);
    }

    const std::string prompt = build_prompt(engine, role_list, content_list);
    std::vector<llama_token> tokens = tokenize(engine->vocab, prompt);
    if (tokens.empty()) {
        LOGE("empty prompt after tokenize");
        return JNI_FALSE;
    }

    llama_memory_clear(llama_get_memory(engine->ctx), true);

    jclass cb_cls = env->GetObjectClass(callback);
    jmethodID on_token = env->GetMethodID(cb_cls, "onToken", "(Ljava/lang/String;)V");
    if (on_token == nullptr) return JNI_FALSE;

    // prompt 分批解码
    const int n_batch = 512;
    for (size_t i = 0; i < tokens.size(); i += static_cast<size_t>(n_batch)) {
        if (engine->cancel.load()) return JNI_FALSE;
        const size_t end = std::min(tokens.size(), i + static_cast<size_t>(n_batch));
        std::vector<llama_token> chunk(tokens.begin() + static_cast<long>(i),
                                       tokens.begin() + static_cast<long>(end));
        llama_batch batch = llama_batch_get_one(chunk.data(), static_cast<int32_t>(chunk.size()));
        if (llama_decode(engine->ctx, batch) != 0) {
            LOGE("llama_decode failed on prompt");
            return JNI_FALSE;
        }
    }

    llama_sampler_chain_params sparams = llama_sampler_chain_default_params();
    sparams.no_perf = true;
    llama_sampler * smpl = llama_sampler_chain_init(sparams);
    llama_sampler_chain_add(smpl, llama_sampler_init_top_k(top_k > 0 ? top_k : 40));
    llama_sampler_chain_add(smpl, llama_sampler_init_top_p(top_p > 0.0f ? top_p : 0.95f, 1));
    llama_sampler_chain_add(smpl, llama_sampler_init_temp(temperature > 0.0f ? temperature : 0.7f));
    llama_sampler_chain_add(smpl, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    std::string pending;
    llama_token token = 0;
    for (int i = 0; i < max_tokens; i += 1) {
        if (engine->cancel.load()) {
            llama_sampler_free(smpl);
            return JNI_FALSE;
        }
        token = llama_sampler_sample(smpl, engine->ctx, -1);
        if (llama_vocab_is_eog(engine->vocab, token)) break;
        llama_sampler_accept(smpl, token);

        char piece[256];
        const int32_t n = llama_token_to_piece(engine->vocab, token, piece, sizeof(piece), 0, true);
        if (n > 0) {
            pending.append(piece, static_cast<size_t>(n));
            const size_t safe = valid_utf8_prefix(pending);
            if (safe > 0) {
                jstring text = utf8_to_jstring(env, pending.substr(0, safe));
                if (text != nullptr) {
                    env->CallVoidMethod(callback, on_token, text);
                    env->DeleteLocalRef(text);
                }
                pending.erase(0, safe);
            }
        }

        llama_batch batch = llama_batch_get_one(&token, 1);
        if (llama_decode(engine->ctx, batch) != 0) {
            LOGE("llama_decode failed on token");
            llama_sampler_free(smpl);
            return JNI_FALSE;
        }
    }

    if (!pending.empty()) {
        jstring text = utf8_to_jstring(env, pending);
        if (text != nullptr) {
            env->CallVoidMethod(callback, on_token, text);
            env->DeleteLocalRef(text);
        }
    }

    llama_sampler_free(smpl);
    return JNI_TRUE;
}

}  // extern "C"
