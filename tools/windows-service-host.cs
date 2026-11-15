// Compiled as WindowsApplication: no console is allocated for this process or its children.
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Web.Script.Serialization;
using System.Security.Cryptography;
using System.Text;
using System.Runtime.InteropServices;

sealed class ChildJob : IDisposable {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits value, int size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct Basic { public long processTime, jobTime; public uint flags; public UIntPtr minimum, maximum; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic basic; public Counters counters; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
    IntPtr handle;
    public ChildJob() {
        handle = CreateJobObject(IntPtr.Zero, null);
        var limits = new Limits(); limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (handle == IntPtr.Zero || !SetInformationJobObject(handle, 9, ref limits, Marshal.SizeOf(typeof(Limits)))) {
            Dispose(); throw new InvalidOperationException("Could not create service child job");
        }
    }
    public void Attach(Process process) {
        if (!AssignProcessToJobObject(handle, process.Handle)) {
            try { process.Kill(); } catch {}
            throw new InvalidOperationException("Could not supervise service child lifetime");
        }
    }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
}

public class ServiceCommand {
    public string executable;
    public string arguments;
    public string directory;
    public string stdout;
    public string stderr;
    public string channelHome;
    public ServiceCommand prepare;
}
public static class WindowsServiceHost {
    static int Run(ServiceCommand c) {
        if (!Path.IsPathRooted(c.executable) || !File.Exists(c.executable))
            throw new InvalidOperationException("Missing absolute service executable");
        Directory.CreateDirectory(Path.GetDirectoryName(c.stdout));
        Directory.CreateDirectory(Path.GetDirectoryName(c.stderr));
        var info = new ProcessStartInfo(c.executable, c.arguments);
        info.WorkingDirectory = c.directory;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        if (!String.IsNullOrEmpty(c.channelHome)) info.EnvironmentVariables["LARK_CHANNEL_HOME"] = c.channelHome;
        using (var output = new StreamWriter(c.stdout, true, new UTF8Encoding(false)))
        using (var error = new StreamWriter(c.stderr, true, new UTF8Encoding(false)))
        using (var job = new ChildJob())
        using (var p = new Process()) {
            output.AutoFlush = true; error.AutoFlush = true;
            p.StartInfo = info;
            p.OutputDataReceived += (s, e) => { if (e.Data != null) lock(output) output.WriteLine(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock(error) error.WriteLine(e.Data); };
            p.Start(); job.Attach(p); p.StandardInput.Close();
            p.BeginOutputReadLine(); p.BeginErrorReadLine();
            p.WaitForExit(); // Wait for stream callbacks too; keep Task Scheduler attached to the child lifetime.
            return p.ExitCode;
        }
    }
    [STAThread]
    public static int Main(string[] args) {
        string file = null;
        try {
            if (args.Length != 1) return 2;
            file = Path.GetFullPath(args[0]);
            string key;
            using (var sha = SHA256.Create()) key = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(file.ToLowerInvariant()))).Replace("-", "");
            using (var mutex = new Mutex(false, "Local\\LarkService-" + key)) {
                bool owned;
                try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
                if (!owned) return 0;
                try {
                    var c = new JavaScriptSerializer().Deserialize<ServiceCommand>(File.ReadAllText(file));
                    if (c.prepare != null) { int code = Run(c.prepare); if (code != 0) return code; }
                    return Run(c);
                } finally { mutex.ReleaseMutex(); }
            }
        } catch (Exception e) {
            if (file != null) try { File.AppendAllText(file + ".error.log", DateTime.UtcNow.ToString("o") + " " + e.Message + Environment.NewLine); } catch {}
            return 1;
        }
    }
}
