import { textToSpeech } from '@kit.CoreSpeechKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { promptAction } from '@kit.ArkUI';

/**
 * Thin wrapper around CoreSpeechKit. The app keeps working when the device
 * has no TTS engine, so every call is guarded.
 */
export class Speech {
  private static engine: textToSpeech.TextToSpeechEngine | null = null;
  private static creating: boolean = false;

  static speak(text: string): void {
    try {
      if (Speech.engine !== null) {
        Speech.doSpeak(Speech.engine, text);
        return;
      }
      if (Speech.creating) {
        return;
      }
      Speech.creating = true;
      const params: textToSpeech.CreateEngineParams = {
        language: 'en-US',
        person: 0,
        online: 1,
        extraParams: {
          'style': 'interaction-broadcast',
          'locate': 'CN',
          'name': 's1'
        }
      };
      textToSpeech.createEngine(params, (err: BusinessError, engine: textToSpeech.TextToSpeechEngine) => {
        Speech.creating = false;
        if (err) {
          promptAction.showToast({ message: '当前设备暂不支持发音' });
          return;
        }
        Speech.engine = engine;
        Speech.doSpeak(engine, text);
      });
    } catch (err) {
      Speech.creating = false;
      console.error(`WordVault: TTS unavailable: ${JSON.stringify(err)}`);
      promptAction.showToast({ message: '当前设备暂不支持发音' });
    }
  }

  private static doSpeak(engine: textToSpeech.TextToSpeechEngine, text: string): void {
    try {
      const params: textToSpeech.SpeakParams = {
        requestId: `${Date.now()}`,
        extraParams: {
          'speed': 1,
          'volume': 1,
          'pitch': 1,
          'queueMode': 0
        }
      };
      engine.speak(text, params);
    } catch (err) {
      console.error(`WordVault: speak failed: ${JSON.stringify(err)}`);
    }
  }
}
