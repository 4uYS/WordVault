using System;
using System.Diagnostics;
using System.IO;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string html = Path.Combine(baseDir, "index.html");
        if (!File.Exists(html))
        {
            return;
        }

        string url = new Uri(html).AbsoluteUri;
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        string[] browsers =
        {
            Path.Combine(programFilesX86, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(programFiles, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(programFiles, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(programFilesX86, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(localAppData, @"Google\Chrome\Application\chrome.exe"),
        };

        foreach (string browser in browsers)
        {
            if (!File.Exists(browser)) continue;
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = browser,
                    Arguments = "--app=\"" + url + "\" --window-size=1200,900 --disable-features=Translate",
                    UseShellExecute = true,
                });
                return;
            }
            catch
            {
                // 尝试下一个浏览器
            }
        }

        // 没有 Edge/Chrome 时用默认浏览器打开
        Process.Start(new ProcessStartInfo { FileName = html, UseShellExecute = true });
    }
}
