using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Windows GUI 子系统启动器：同步运行 Node Hook，但不创建控制台窗口。
internal static class AgentLensWindowsHookRunner
{
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handleType);

    private static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            WriteError("AgentLens Windows Hook 启动器需要一个脚本路径。\n");
            return 64;
        }

        try
        {
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = "node.exe";
            startInfo.Arguments = QuoteArgument(args[0]);
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            startInfo.RedirectStandardInput = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.WorkingDirectory = Environment.CurrentDirectory;

            using (Process child = new Process())
            {
                child.StartInfo = startInfo;
                child.Start();

                Stream parentInput = OpenStandardHandle(StdInputHandle, FileAccess.Read);
                Stream parentOutput = OpenStandardHandle(StdOutputHandle, FileAccess.Write);
                Stream parentError = OpenStandardHandle(StdErrorHandle, FileAccess.Write);
                Exception pumpError = null;

                Thread inputPump = StartPump(delegate
                {
                    Pump(parentInput, child.StandardInput.BaseStream, true);
                }, delegate(Exception error) { pumpError = error; });
                Thread outputPump = StartPump(delegate
                {
                    Pump(child.StandardOutput.BaseStream, parentOutput, false);
                }, delegate(Exception error) { pumpError = error; });
                Thread errorPump = StartPump(delegate
                {
                    Pump(child.StandardError.BaseStream, parentError, false);
                }, delegate(Exception error) { pumpError = error; });

                child.WaitForExit();
                outputPump.Join();
                errorPump.Join();
                inputPump.Join();

                if (pumpError != null)
                {
                    WriteError("AgentLens Windows Hook 标准流转发失败：" + pumpError.Message + "\n");
                    return child.ExitCode == 0 ? 1 : child.ExitCode;
                }
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            WriteError("AgentLens Windows Hook 启动失败：" + error.Message + "\n");
            return 1;
        }
    }

    private static Thread StartPump(ThreadStart action, Action<Exception> onError)
    {
        Thread thread = new Thread(new ThreadStart(delegate
        {
            try { action(); }
            catch (Exception error) { onError(error); }
        }));
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static void Pump(Stream source, Stream destination, bool closeDestination)
    {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
        {
            destination.Write(buffer, 0, read);
            destination.Flush();
        }
        if (closeDestination) destination.Close();
    }

    private static Stream OpenStandardHandle(int handleType, FileAccess access)
    {
        IntPtr handle = GetStdHandle(handleType);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return Stream.Null;
        return new FileStream(new SafeFileHandle(handle, false), access, 4096, false);
    }

    private static string QuoteArgument(string value)
    {
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        foreach (char current in value)
        {
            if (current == '\\')
            {
                slashes += 1;
                continue;
            }
            if (current == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(current);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void WriteError(string message)
    {
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(message);
            Stream stderr = OpenStandardHandle(StdErrorHandle, FileAccess.Write);
            stderr.Write(bytes, 0, bytes.Length);
            stderr.Flush();
        }
        catch { }
    }
}
