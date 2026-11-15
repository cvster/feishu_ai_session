// MCP stdio bootstrap only. Uses the bundled node_repl and sky unchanged;
// never implements or connects to the Computer Use helper protocol itself.
using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Collections.Generic;

public static class NodeReplHost {
    static async Task Pump(Stream source, Stream destination) {
        byte[] buffer = new byte[16384];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) > 0) {
            await destination.WriteAsync(buffer, 0, count);
            await destination.FlushAsync();
        }
    }
    static int Main(string[] args) {
        try {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string root = Path.Combine(local, "OpenAI", "Codex", "runtimes", "cua_node");
            string runtime = Directory.GetDirectories(root).Where(d => !Path.GetFileName(d).StartsWith(".staging"))
                .Select(d => Path.Combine(d, "bin"))
                .Where(d => File.Exists(Path.Combine(d,"node_repl.exe")) && File.Exists(Path.Combine(d,"node.exe")) && File.Exists(Path.Combine(d,"node_modules","@oai","sky","package.json")))
                .OrderByDescending(d => File.GetLastWriteTimeUtc(Path.Combine(d,"node_repl.exe"))).FirstOrDefault();
            if (runtime == null) throw new Exception("No complete bundled node_repl runtime. Start/update Codex Desktop.");
            string[] pipes = Directory.GetFiles(@"\\.\pipe\")
                .Where(p => System.Text.RegularExpressions.Regex.IsMatch(p, @"codex-computer-use-[a-f0-9]{8}-[a-f0-9-]{27}$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)).ToArray();
            if (pipes.Length != 1) throw new Exception("Expected exactly one Desktop Computer Use pipe; found " + pipes.Length + ". No endpoint was guessed.");
            string cli = null;
            string config = Path.Combine(home,".lark-channel","profiles","codex","workers","codex","config.json");
            if (File.Exists(config)) {
                var parsed = new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(config));
                var options = parsed["options"] as Dictionary<string,object>;
                if (options != null && options.ContainsKey("binaryPath")) cli = options["binaryPath"] as string;
            }
            if (String.IsNullOrEmpty(cli) || !File.Exists(cli)) throw new Exception("Protected Codex CLI unavailable. Repair the Windows bridge runtime first.");
            if (args.Length == 1 && args[0] == "--check") {
                Console.WriteLine(new JavaScriptSerializer().Serialize(new { runtime=runtime, cli=cli, computerUsePipes=pipes.Length })); return 0;
            }
            if (args.Length != 0) throw new Exception("Unexpected bootstrap arguments.");
            var info = new ProcessStartInfo(Path.Combine(runtime,"node_repl.exe"));
            info.UseShellExecute=false; info.CreateNoWindow=true;
            info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
            string modules = Path.Combine(runtime,"node_modules");
            info.EnvironmentVariables["NODE_REPL_NODE_MODULE_DIRS"] = modules;
            info.EnvironmentVariables["NODE_REPL_NODE_PATH"] = Path.Combine(runtime,"node.exe");
            info.EnvironmentVariables["NODE_REPL_TRUSTED_CODE_PATHS"] = Path.Combine(home,".codex") + ";" + modules;
            info.EnvironmentVariables["SKY_CUA_NATIVE_PIPE"] = "1";
            info.EnvironmentVariables["SKY_CUA_NATIVE_PIPE_DIRECTORY"] = pipes[0];
            info.EnvironmentVariables["CODEX_CLI_PATH"] = cli;
            info.EnvironmentVariables["PATH"] = Path.GetDirectoryName(cli) + ";" + Environment.GetEnvironmentVariable("PATH");
            using (var p = Process.Start(info)) {
                // Forward bytes, not PowerShell objects or reformatted JSON. No model input is generated.
                var output = Pump(p.StandardOutput.BaseStream,Console.OpenStandardOutput());
                var error = Pump(p.StandardError.BaseStream,Console.OpenStandardError());
                var input = Task.Run(() => Pump(Console.OpenStandardInput(),p.StandardInput.BaseStream));
                input.ContinueWith(t => { try { p.StandardInput.Close(); } catch {} });
                p.WaitForExit(); Task.WaitAll(output,error); return p.ExitCode;
            }
        } catch (Exception e) { Console.Error.WriteLine("Windows node_repl bootstrap: " + e.Message); return 1; }
    }
}
