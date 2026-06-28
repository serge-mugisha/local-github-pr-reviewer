import { spawn } from "node:child_process";

interface CommandResult {
  stdout: string;
  stderr: string;
}

class CommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        rejectP(
          new CommandError(
            stderr.trim() || `${command} exited ${code}`,
            command,
            code,
            stdout,
            stderr,
          ),
        );
        return;
      }
      resolveP({ stdout, stderr });
    });
    child.on("error", rejectP);
  });
}

function isCancelMessage(message: string): boolean {
  return /user canceled|cancelled|canceled/i.test(message);
}

function isLinuxDialogCancel(command: string, e: unknown): boolean {
  return (
    e instanceof CommandError &&
    e.command === command &&
    e.code === 1 &&
    e.stderr.trim() === "" &&
    e.stdout.trim() === ""
  );
}

async function pickDarwin(): Promise<string | null> {
  try {
    const result = await run("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Select a local Git repository")',
    ]);
    return result.stdout.trim() || null;
  } catch (e) {
    const message = (e as Error).message;
    if (isCancelMessage(message)) return null;
    throw e;
  }
}

async function pickWindows(): Promise<string | null> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select a local Git repository'",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }",
  ].join("; ");
  const result = await run("powershell.exe", ["-NoProfile", "-Command", script]);
  return result.stdout.trim() || null;
}

async function pickLinux(): Promise<string | null> {
  const attempts: Array<[string, string[]]> = [
    ["zenity", ["--file-selection", "--directory", "--title=Select a local Git repository"]],
    ["kdialog", ["--getexistingdirectory", ".", "Select a local Git repository"]],
  ];
  const errors: string[] = [];
  for (const [command, args] of attempts) {
    try {
      const result = await run(command, args);
      return result.stdout.trim() || null;
    } catch (e) {
      const message = (e as Error).message;
      if (isCancelMessage(message) || isLinuxDialogCancel(command, e)) return null;
      errors.push(`${command}: ${message}`);
    }
  }
  throw new Error(`No supported folder picker is available. Tried ${errors.join("; ")}`);
}

export async function pickFolder(): Promise<string | null> {
  if (process.platform === "darwin") return pickDarwin();
  if (process.platform === "win32") return pickWindows();
  if (process.platform === "linux") return pickLinux();
  throw new Error(`Folder picker is not supported on ${process.platform}`);
}
