// HostShellRunner.cpp
//
// Runs one Bash script as a host process under a Win32 Job Object.
// The process is created suspended, joined to a job with KILL_ON_JOB_CLOSE and
// only then resumed, so a timeout or an aborted parent takes the whole process
// tree with it. This is not a sandbox: the command runs with the host token and
// its network and filesystem reach are the host's.
//
// Usage:
//   HostShellRunner.exe --bash <bash.exe> --script <file> --cwd <dir>
//                       --env <file> --out <file> --err <file> --timeout <ms>
// Emits one JSON object on its own stdout.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

std::wstring Utf8ToWide(const std::string& text) {
  if (text.empty()) return std::wstring();
  const int size = MultiByteToWideChar(CP_UTF8, 0, text.data(),
                                       static_cast<int>(text.size()), nullptr, 0);
  std::wstring wide(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                      &wide[0], size);
  return wide;
}

std::string WideToUtf8(const std::wstring& text) {
  if (text.empty()) return std::string();
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(),
                                       static_cast<int>(text.size()), nullptr, 0,
                                       nullptr, nullptr);
  std::string utf8(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                      &utf8[0], size, nullptr, nullptr);
  return utf8;
}

bool ReadFileBytes(const std::wstring& path, std::string& out) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  out.clear();
  char buffer[16384];
  bool ok = true;
  for (;;) {
    DWORD read = 0;
    const BOOL result = ReadFile(file, buffer, sizeof(buffer), &read, nullptr);
    if (result == FALSE) {
      ok = false;
      break;
    }
    if (read == 0) break;
    out.append(buffer, read);
  }
  CloseHandle(file);
  return ok;
}

bool WriteFileBytes(const std::wstring& path, const std::string& text) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const BOOL ok = WriteFile(file, text.data(), static_cast<DWORD>(text.size()),
                            &written, nullptr);
  CloseHandle(file);
  return ok == TRUE;
}

struct Options {
  std::wstring bash;
  std::wstring script;
  std::wstring cwd;
  std::wstring env;
  std::wstring out;
  std::wstring err;
  DWORD timeoutMs = 60000;
};

bool ParseArgs(int argc, wchar_t** argv, Options& options, std::string& error) {
  for (int index = 1; index + 1 < argc; index += 2) {
    const std::wstring key(argv[index]);
    const std::wstring value(argv[index + 1]);
    if (key == L"--bash") options.bash = value;
    else if (key == L"--script") options.script = value;
    else if (key == L"--cwd") options.cwd = value;
    else if (key == L"--env") options.env = value;
    else if (key == L"--out") options.out = value;
    else if (key == L"--err") options.err = value;
    else if (key == L"--timeout") {
      const long parsed = std::strtol(WideToUtf8(value).c_str(), nullptr, 10);
      options.timeoutMs = parsed > 0
        ? static_cast<DWORD>(parsed)
        : 60000;
    } else {
      error = "unknown argument: " + WideToUtf8(key);
      return false;
    }
  }
  if (options.bash.empty() || options.script.empty() || options.cwd.empty()) {
    error = "missing required arguments";
    return false;
  }
  return true;
}

std::wstring NormalizeSeparators(const std::wstring& path) {
  std::wstring result(path);
  for (auto& character : result) {
    if (character == L'/') character = L'\\';
  }
  return result;
}

std::wstring Quote(const std::wstring& path) {
  return L"\"" + NormalizeSeparators(path) + L"\"";
}

// The parent hands over an explicit KEY=VALUE list; nothing is inherited.
bool BuildEnvironmentBlock(const std::wstring& path, std::wstring& block,
                           std::string& error) {
  std::string raw;
  if (!ReadFileBytes(path, raw)) {
    error = "cannot read environment file";
    return false;
  }
  std::vector<std::wstring> entries;
  size_t start = 0;
  while (start <= raw.size()) {
    size_t end = raw.find('\n', start);
    if (end == std::string::npos) end = raw.size();
    std::string line = raw.substr(start, end - start);
    start = end + 1;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    std::wstring wide = Utf8ToWide(line);
    for (auto& character : wide) {
      if (character == L'\0') {
        error = "environment value contains NUL";
        return false;
      }
    }
    entries.push_back(wide);
  }
  struct CaseLess {
    bool operator()(const std::wstring& left, const std::wstring& right) const {
      return _wcsicmp(left.c_str(), right.c_str()) < 0;
    }
  };
  std::sort(entries.begin(), entries.end(), CaseLess());
  block.clear();
  for (const auto& entry : entries) {
    block += entry;
    block += L'\0';
  }
  block += L'\0';
  return true;
}

void EmitResult(const std::string& json) {
  std::fwrite(json.data(), 1, json.size(), stdout);
  std::fflush(stdout);
}

std::string JsonEscape(const std::string& text) {
  std::string out;
  for (char character : text) {
    switch (character) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(character) < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", character);
          out += buffer;
        } else {
          out += character;
        }
    }
  }
  return out;
}

void EmitError(const std::string& message) {
  EmitResult("{\"error\":\"" + JsonEscape(message) + "\"}\n");
}

HANDLE CreateRedirectHandle(const std::wstring& path, SECURITY_ATTRIBUTES& attributes) {
  attributes.nLength = sizeof(SECURITY_ATTRIBUTES);
  attributes.bInheritHandle = TRUE;
  attributes.lpSecurityDescriptor = nullptr;
  return CreateFileW(NormalizeSeparators(path).c_str(), GENERIC_WRITE,
                     FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, CREATE_ALWAYS,
                     FILE_ATTRIBUTE_NORMAL, nullptr);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Options options;
  std::string error;
  if (!ParseArgs(argc, argv, options, error)) {
    EmitError(error);
    return 2;
  }

  std::wstring envBlock;
  if (!options.env.empty()) {
    if (!BuildEnvironmentBlock(options.env, envBlock, error)) {
      EmitError(error);
      return 2;
    }
  }

  SECURITY_ATTRIBUTES outAttributes{};
  SECURITY_ATTRIBUTES errAttributes{};
  HANDLE outHandle = options.out.empty()
    ? nullptr
    : CreateRedirectHandle(options.out, outAttributes);
  if (!outHandle) {
    EmitError("cannot create stdout file");
    return 2;
  }
  HANDLE errHandle = options.err.empty()
    ? nullptr
    : CreateRedirectHandle(options.err, errAttributes);
  if (!errHandle) {
    CloseHandle(outHandle);
    EmitError("cannot create stderr file");
    return 2;
  }
  HANDLE nulHandle = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ, nullptr,
                                 OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (nulHandle == INVALID_HANDLE_VALUE) {
    nulHandle = GetStdHandle(STD_INPUT_HANDLE);
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    CloseHandle(errHandle);
    CloseHandle(outHandle);
    EmitError("cannot create job object");
    return 2;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    CloseHandle(job);
    CloseHandle(errHandle);
    CloseHandle(outHandle);
    EmitError("cannot configure job object");
    return 2;
  }

  std::wstring commandLine = Quote(options.bash)
    + L" --noprofile --norc " + Quote(options.script);
  std::vector<wchar_t> commandBuffer(commandLine.begin(), commandLine.end());
  commandBuffer.push_back(L'\0');

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = nulHandle;
  startup.hStdOutput = outHandle;
  startup.hStdError = errHandle;

  PROCESS_INFORMATION process{};
  const BOOL created = CreateProcessW(
      nullptr,
      commandBuffer.data(),
      nullptr,
      nullptr,
      TRUE,
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
      envBlock.empty() ? nullptr : envBlock.data(),
      options.cwd.empty() ? nullptr : NormalizeSeparators(options.cwd).c_str(),
      &startup,
      &process);
  CloseHandle(outHandle);
  CloseHandle(errHandle);
  if (nulHandle && nulHandle != INVALID_HANDLE_VALUE) CloseHandle(nulHandle);

  if (!created) {
    const DWORD lastError = GetLastError();
    CloseHandle(job);
    EmitError("cannot create process: " + std::to_string(lastError));
    return 2;
  }

  // Fail closed: without the job there is no way to guarantee that the whole
  // process tree stops on timeout or revoke.
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    const DWORD lastError = GetLastError();
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    EmitError("cannot assign process to job object: " + std::to_string(lastError));
    return 2;
  }

  ResumeThread(process.hThread);

  const DWORD wait = WaitForSingleObject(process.hProcess, options.timeoutMs);
  bool timedOut = false;
  if (wait == WAIT_TIMEOUT) {
    timedOut = true;
    TerminateJobObject(job, 124);
    WaitForSingleObject(process.hProcess, 5000);
  }

  DWORD exitCode = static_cast<DWORD>(-1);
  if (!GetExitCodeProcess(process.hProcess, &exitCode)) {
    exitCode = static_cast<DWORD>(-1);
  }
  if (timedOut) exitCode = 124;

  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  // Closing the job releases it; KILL_ON_JOB_CLOSE removes any descendant that
  // outlived the direct child.
  CloseHandle(job);

  if (timedOut) {
    EmitResult("{\"exitCode\":124,\"timedOut\":true}\n");
  } else {
    EmitResult("{\"exitCode\":" + std::to_string(exitCode) + ",\"timedOut\":false}\n");
  }
  return 0;
}
