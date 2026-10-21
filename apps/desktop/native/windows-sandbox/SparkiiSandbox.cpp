#define UNICODE
#define _UNICODE
#define NOMINMAX
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <cwctype>
#include <map>

#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")

namespace {

struct Config {
  std::wstring profile;
  std::wstring workspace;
  std::wstring scratch;
  std::wstring runtimeRoot;
  std::wstring executable;
  std::wstring cwd;
  std::wstring commandBase64;
  std::vector<std::wstring> deny;
  std::vector<std::pair<std::wstring, std::wstring>> extraEnv;
  DWORD timeoutMs = 60000;
};

std::wstring Quote(const std::wstring& value) {
  std::wstring out = L"\"";
  for (wchar_t ch : value) {
    if (ch == L'"') out += L'\\';
    out += ch;
  }
  out += L"\"";
  return out;
}

std::vector<unsigned char> DecodeBase64(const std::wstring& input) {
  static const std::string alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string bytes;
  for (wchar_t ch : input) {
    if (ch == L'=') break;
    if (ch == L'\r' || ch == L'\n' || ch == L' ') continue;
    size_t pos = alphabet.find(static_cast<char>(ch));
    if (pos == std::string::npos) continue;
    bytes.push_back(static_cast<char>(pos));
  }
  std::vector<unsigned char> out;
  uint32_t acc = 0;
  int bits = 0;
  for (unsigned char value : bytes) {
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<unsigned char>((acc >> bits) & 0xff));
    }
  }
  return out;
}

std::wstring Utf8ToWide(const std::vector<unsigned char>& bytes) {
  if (bytes.empty()) return std::wstring();
  int length = MultiByteToWideChar(
      CP_UTF8, 0, reinterpret_cast<const char*>(bytes.data()),
      static_cast<int>(bytes.size()), nullptr, 0);
  if (length <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(length), L'\0');
  MultiByteToWideChar(
      CP_UTF8, 0, reinterpret_cast<const char*>(bytes.data()),
      static_cast<int>(bytes.size()), out.data(), length);
  return out;
}

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) return "";
  int length = WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
      nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(length), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
      out.data(), length, nullptr, nullptr);
  return out;
}

std::string JsonEscape(const std::wstring& value) {
  std::string utf8 = WideToUtf8(value);
  std::string out;
  for (char ch : utf8) {
    switch (ch) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(ch) >= 0x20) out += ch;
    }
  }
  return out;
}

std::wstring ReadTextFile(const std::wstring& path) {
  HANDLE file = CreateFileW(
      path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return std::wstring();
  std::string utf8;
  char buffer[8192];
  DWORD read = 0;
  while (ReadFile(file, buffer, sizeof(buffer), &read, nullptr) && read > 0) {
    utf8.append(buffer, read);
  }
  CloseHandle(file);
  int length = MultiByteToWideChar(
      CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(std::max(0, length)), L'\0');
  if (length > 0) {
    MultiByteToWideChar(
        CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()),
        out.data(), length);
  }
  return out;
}

bool RunProcess(
    const std::wstring& application,
    const std::wstring& commandLine,
    DWORD* exitCode) {
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  std::wstring mutableCommand = commandLine;
  BOOL ok = CreateProcessW(
      application.c_str(), mutableCommand.data(), nullptr, nullptr, FALSE,
      CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
  if (!ok) return false;
  WaitForSingleObject(process.hProcess, 10000);
  DWORD code = 1;
  GetExitCodeProcess(process.hProcess, &code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (exitCode) *exitCode = code;
  return true;
}

bool AclGrant(
    const std::wstring& target,
    const std::wstring& sid,
    const std::wstring& rights,
    bool recursive = false) {
  DWORD code = 1;
  return RunProcess(
      L"C:\\Windows\\System32\\icacls.exe",
      L"icacls.exe " + Quote(target) + L" /grant \"*" + sid + L":" + rights + L"\""
          + (recursive ? L" /T /C" : L""),
      &code)
      && code == 0;
}

bool AclDeny(const std::wstring& target, const std::wstring& sid) {
  DWORD code = 1;
  DWORD attributes = GetFileAttributesW(target.c_str());
  std::wstring rights = (attributes != INVALID_FILE_ATTRIBUTES
      && (attributes & FILE_ATTRIBUTE_DIRECTORY))
      ? L"(OI)(CI)(R,W,D)"
      : L"(R,W,D)";
  return RunProcess(
      L"C:\\Windows\\System32\\icacls.exe",
      L"icacls.exe " + Quote(target) + L" /deny \"*" + sid + L":" + rights + L"\"",
      &code)
      && code == 0;
}

bool AclRemove(const std::wstring& target, const std::wstring& sid) {
  DWORD code = 1;
  RunProcess(
      L"C:\\Windows\\System32\\icacls.exe",
      L"icacls.exe " + Quote(target) + L" /remove:d \"*" + sid + L"\" /remove:g \"*" + sid + L"\"",
      &code);
  return true;
}

bool EnsureDirectory(const std::wstring& path) {
  if (path.empty()) return false;
  size_t begin = 0;
  if (path.size() >= 3 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) {
    begin = 3;
  }
  for (size_t i = begin; i <= path.size(); ++i) {
    if (i != path.size() && path[i] != L'\\' && path[i] != L'/') continue;
    std::wstring current = path.substr(0, i);
    if (current.empty()) continue;
    if (!CreateDirectoryW(current.c_str(), nullptr)
        && GetLastError() != ERROR_ALREADY_EXISTS) {
      return false;
    }
  }
  return true;
}

std::vector<wchar_t> BuildEnvironment(
    const std::wstring& scratch,
    const std::wstring& runtimeRoot,
    const std::vector<std::pair<std::wstring, std::wstring>>& extraEnv) {
  std::map<std::wstring, std::wstring> values = {
      {L"SystemRoot", L"C:\\Windows"},
      {L"WINDIR", L"C:\\Windows"},
      {L"SystemDrive", L"C:"},
      {L"ProgramData", L"C:\\ProgramData"},
      {L"PATH", runtimeRoot + L";C:\\Windows\\System32;C:\\Windows"},
      {L"TEMP", scratch + L"\\temp"},
      {L"TMP", scratch + L"\\temp"},
      {L"HOME", scratch + L"\\home"},
      {L"USERPROFILE", scratch + L"\\home"},
      {L"HOMEDRIVE", L"C:"},
      {L"HOMEPATH", L"\\"},
      {L"APPDATA", scratch + L"\\appdata"},
      {L"LOCALAPPDATA", scratch + L"\\localappdata"},
      {L"ComSpec", L"C:\\Windows\\System32\\cmd.exe"},
      {L"OS", L"Windows_NT"},
      {L"LANG", L"en_US.UTF-8"},
  };
  for (const auto& [name, value] : extraEnv) values[name] = value;
  std::vector<wchar_t> block;
  for (const auto& [name, value] : values) {
    std::wstring entry = name + L"=" + value;
    block.insert(block.end(), entry.begin(), entry.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

bool DeleteProfile(const std::wstring& profile) {
  HRESULT hr = DeleteAppContainerProfile(profile.c_str());
  return hr == S_OK || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
}

std::wstring SidText(PSID sid) {
  LPWSTR text = nullptr;
  if (!ConvertSidToStringSidW(sid, &text)) return std::wstring();
  std::wstring out = text ? text : L"";
  if (text) LocalFree(text);
  return out;
}

std::string SuccessJson(
    DWORD exitCode,
    bool timedOut,
    const std::wstring& stdoutPath,
    const std::wstring& stderrPath,
    const std::wstring& sid) {
  std::wstring output = ReadTextFile(stdoutPath);
  std::wstring error = ReadTextFile(stderrPath);
  return "{\"ok\":true,\"exitCode\":" + std::to_string(exitCode)
      + ",\"timedOut\":" + (timedOut ? "true" : "false")
      + ",\"stdout\":\"" + JsonEscape(output)
      + "\",\"stderr\":\"" + JsonEscape(error)
      + "\",\"sandboxSid\":\"" + JsonEscape(sid) + "\"}";
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Config config;
  config.profile = L"Sparkii.Sandbox." + std::to_wstring(GetCurrentProcessId());
  for (int i = 1; i < argc; ++i) {
    std::wstring arg = argv[i];
    auto next = [&]() -> std::wstring {
      if (i + 1 >= argc) return L"";
      return argv[++i];
    };
    if (arg == L"--profile") config.profile = next();
    else if (arg == L"--workspace") config.workspace = next();
    else if (arg == L"--scratch") config.scratch = next();
    else if (arg == L"--runtime-root") config.runtimeRoot = next();
    else if (arg == L"--exe") config.executable = next();
    else if (arg == L"--cwd") config.cwd = next();
    else if (arg == L"--command-base64") config.commandBase64 = next();
    else if (arg == L"--deny") config.deny.push_back(next());
    else if (arg == L"--env") {
      std::wstring pair = next();
      size_t separator = pair.find(L'=');
      if (separator != std::wstring::npos) {
        config.extraEnv.emplace_back(
            pair.substr(0, separator), pair.substr(separator + 1));
      }
    }
    else if (arg == L"--timeout-ms") config.timeoutMs = static_cast<DWORD>(_wtoi(next().c_str()));
  }
  if (config.workspace.empty() || config.scratch.empty()
      || config.runtimeRoot.empty() || config.executable.empty()
      || config.cwd.empty()) {
    std::puts("{\"ok\":false,\"error\":\"missing sandbox configuration\"}");
    return 2;
  }
  if (!EnsureDirectory(config.workspace) || !EnsureDirectory(config.scratch)
      || !EnsureDirectory(config.scratch + L"\\temp")
      || !EnsureDirectory(config.scratch + L"\\home")
      || !EnsureDirectory(config.scratch + L"\\appdata")
      || !EnsureDirectory(config.scratch + L"\\localappdata")) {
    std::puts("{\"ok\":false,\"error\":\"cannot create sandbox directories\"}");
    return 3;
  }

  PSID sid = nullptr;
  HRESULT hr = CreateAppContainerProfile(
      config.profile.c_str(), config.profile.c_str(), L"Sparkii task sandbox",
      nullptr, 0, &sid);
  if (FAILED(hr) && hr != HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
    std::puts("{\"ok\":false,\"error\":\"cannot create AppContainer profile\"}");
    return 4;
  }
  if (!sid) {
    hr = DeriveAppContainerSidFromAppContainerName(config.profile.c_str(), &sid);
  }
  if (!sid) {
    std::puts("{\"ok\":false,\"error\":\"cannot derive AppContainer SID\"}");
    return 5;
  }
  std::wstring sidText = SidText(sid);
  if (sidText.empty()) {
    std::puts("{\"ok\":false,\"error\":\"cannot convert AppContainer SID\"}");
    LocalFree(sid);
    DeleteProfile(config.profile);
    return 6;
  }
  if (!AclGrant(config.workspace, sidText, L"(OI)(CI)M", true)) {
    std::puts("{\"ok\":false,\"error\":\"cannot grant workspace ACL\"}");
    LocalFree(sid);
    DeleteProfile(config.profile);
    return 6;
  }
  if (!AclGrant(config.scratch, sidText, L"(OI)(CI)M", true)) {
    std::puts("{\"ok\":false,\"error\":\"cannot grant scratch ACL\"}");
    LocalFree(sid);
    DeleteProfile(config.profile);
    return 6;
  }
  if (!AclGrant(config.runtimeRoot, sidText, L"(OI)(CI)RX")) {
    std::puts("{\"ok\":false,\"error\":\"cannot grant runtime ACL\"}");
    LocalFree(sid);
    DeleteProfile(config.profile);
    return 6;
  }
  AclGrant(config.runtimeRoot, sidText, L"(OI)(CI)RX", true);
  for (const auto& target : config.deny) {
    if (!AclDeny(target, sidText)) {
      std::puts("{\"ok\":false,\"error\":\"cannot protect sandbox trust anchor\"}");
      LocalFree(sid);
      DeleteProfile(config.profile);
      return 8;
    }
  }

  SECURITY_CAPABILITIES capabilities{};
  capabilities.AppContainerSid = sid;
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes =
      reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(
          GetProcessHeap(), HEAP_ZERO_MEMORY, attributeSize));
  BOOL initialized = attributes
      && InitializeProcThreadAttributeList(attributes, 1, 0, &attributeSize);
  BOOL updated = initialized
      && UpdateProcThreadAttribute(
          attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
          &capabilities, sizeof(capabilities), nullptr, nullptr);

  SECURITY_ATTRIBUTES inheritable{};
  inheritable.nLength = sizeof(inheritable);
  inheritable.bInheritHandle = TRUE;
  std::wstring stdoutPath = config.scratch + L"\\stdout.log";
  std::wstring stderrPath = config.scratch + L"\\stderr.log";
  HANDLE stdoutFile = CreateFileW(
      stdoutPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &inheritable, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  HANDLE stderrFile = CreateFileW(
      stderrPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &inheritable, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  HANDLE nul = CreateFileW(
      L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);

  std::wstring command = Utf8ToWide(DecodeBase64(config.commandBase64));
  std::wstring commandLine = Quote(config.executable);
  if (!command.empty()) {
    std::wstring executableLower = config.executable;
    std::transform(executableLower.begin(), executableLower.end(), executableLower.begin(),
                   [](wchar_t ch) { return static_cast<wchar_t>(towlower(ch)); });
    if (executableLower.size() >= 8
        && executableLower.substr(executableLower.size() - 8) == L"bash.exe") {
      commandLine += L" -c " + Quote(command);
    } else {
      commandLine += L" " + command;
    }
  }
  std::vector<wchar_t> environment = BuildEnvironment(
      config.scratch, config.runtimeRoot, config.extraEnv);

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = nul;
  startup.StartupInfo.hStdOutput = stdoutFile;
  startup.StartupInfo.hStdError = stderrFile;
  startup.lpAttributeList = attributes;

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));

  PROCESS_INFORMATION process{};
  BOOL created = updated && CreateProcessW(
      config.executable.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT
          | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
      environment.data(), config.cwd.c_str(),
      reinterpret_cast<LPSTARTUPINFOW>(&startup), &process);
  if (!created) {
    DWORD error = GetLastError();
    std::printf("{\"ok\":false,\"error\":\"CreateProcess failed\",\"win32Error\":%lu}\n", error);
    if (attributes) DeleteProcThreadAttributeList(attributes);
    if (attributes) HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(nul);
    CloseHandle(stdoutFile);
    CloseHandle(stderrFile);
    if (job) CloseHandle(job);
    LocalFree(sid);
    DeleteProfile(config.profile);
    return 7;
  }

  BOOL assigned = AssignProcessToJobObject(job, process.hProcess);
  ResumeThread(process.hThread);
  DWORD wait = assigned ? WaitForSingleObject(process.hProcess, config.timeoutMs) : WAIT_FAILED;
  bool timedOut = wait == WAIT_TIMEOUT;
  if (timedOut || !assigned) TerminateJobObject(job, 1);
  if (timedOut || !assigned) WaitForSingleObject(process.hProcess, 10000);
  DWORD exitCode = 1;
  GetExitCodeProcess(process.hProcess, &exitCode);

  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (job) CloseHandle(job);
  CloseHandle(nul);
  CloseHandle(stdoutFile);
  CloseHandle(stderrFile);
  if (attributes) DeleteProcThreadAttributeList(attributes);
  if (attributes) HeapFree(GetProcessHeap(), 0, attributes);
  for (const auto& target : config.deny) AclRemove(target, sidText);
  AclRemove(config.workspace, sidText);
  AclRemove(config.scratch, sidText);
  AclRemove(config.runtimeRoot, sidText);
  LocalFree(sid);
  DeleteProfile(config.profile);

  std::string result = SuccessJson(exitCode, timedOut, stdoutPath, stderrPath, sidText);
  std::fwrite(result.data(), 1, result.size(), stdout);
  std::fputc('\n', stdout);
  return (exitCode == 0 && !timedOut) ? 0 : 1;
}
