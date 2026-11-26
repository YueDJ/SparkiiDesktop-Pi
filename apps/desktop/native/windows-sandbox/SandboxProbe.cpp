#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <fcntl.h>
#include <io.h>
#include <string>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <vector>

#pragma comment(lib, "ws2_32.lib")

namespace {
std::wstring Arg(int argc, wchar_t** argv, int index) {
  return index < argc ? argv[index] : L"";
}

int WriteFileProbe(const std::wstring& path) {
  HANDLE file = CreateFileW(
      path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
      FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return 10;
  const char payload[] = "sandbox-write";
  DWORD written = 0;
  BOOL ok = WriteFile(file, payload, sizeof(payload) - 1, &written, nullptr);
  CloseHandle(file);
  return ok ? 0 : 11;
}

int ReadFileProbe(const std::wstring& path) {
  HANDLE file = CreateFileW(
      path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return 20;
  char buffer[1024];
  DWORD read = 0;
  BOOL ok = ReadFile(file, buffer, sizeof(buffer), &read, nullptr);
  CloseHandle(file);
  return ok ? 0 : 21;
}

int TcpProbe(const std::wstring& host, int port) {
  WSADATA data{};
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 30;
  addrinfoW hints{};
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;
  addrinfoW* addresses = nullptr;
  std::wstring portText = std::to_wstring(port);
  if (GetAddrInfoW(host.c_str(), portText.c_str(), &hints, &addresses) != 0) {
    WSACleanup();
    return 31;
  }
  int result = 32;
  for (addrinfoW* current = addresses; current; current = current->ai_next) {
    SOCKET socketHandle = socket(
        current->ai_family, current->ai_socktype, current->ai_protocol);
    if (socketHandle == INVALID_SOCKET) continue;
    if (connect(
        socketHandle, current->ai_addr,
        static_cast<int>(current->ai_addrlen)) == 0) {
      result = 0;
      closesocket(socketHandle);
      break;
    }
    closesocket(socketHandle);
  }
  FreeAddrInfoW(addresses);
  WSACleanup();
  return result;
}

int PipeProbe(const std::wstring& name) {
  HANDLE pipe = CreateFileW(
      name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) return 40;
  CloseHandle(pipe);
  return 0;
}

int ReparseProbe(int argc, wchar_t** argv) {
  for (int index = 2; index < argc; ++index) {
    const DWORD attributes = GetFileAttributesW(argv[index]);
    if (attributes == INVALID_FILE_ATTRIBUTES) return 60;
    std::printf("%lu\n", (attributes & FILE_ATTRIBUTE_REPARSE_POINT) ? 1UL : 0UL);
  }
  std::fflush(stdout);
  return 0;
}

bool ReadExact(void* buffer, size_t length) {
  return length == 0 || std::fread(buffer, 1, length, stdin) == length;
}

bool WriteExact(const void* buffer, size_t length) {
  return length == 0 || std::fwrite(buffer, 1, length, stdout) == length;
}

int ReparseDaemon() {
  if (_setmode(_fileno(stdin), _O_BINARY) == -1) return 61;
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return 62;
  for (;;) {
    uint32_t count = 0;
    if (std::fread(&count, sizeof(count), 1, stdin) != 1) {
      return std::feof(stdin) ? 0 : 63;
    }
    if (count > 1000000) return 64;
    std::vector<uint8_t> results(count, 2);
    for (uint32_t index = 0; index < count; ++index) {
      uint32_t length = 0;
      if (!ReadExact(&length, sizeof(length)) || length > 1000000) return 65;
      std::vector<char> utf8(length);
      if (!ReadExact(utf8.data(), utf8.size())) return 66;
      const int wideLength = MultiByteToWideChar(
          CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
      if (wideLength <= 0) continue;
      std::vector<wchar_t> wide(static_cast<size_t>(wideLength) + 1, L'\0');
      if (MultiByteToWideChar(
          CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()),
          wide.data(), wideLength) != wideLength) {
        continue;
      }
      const DWORD attributes = GetFileAttributesW(wide.data());
      if (attributes != INVALID_FILE_ATTRIBUTES) {
        results[index] = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) ? 1 : 0;
      }
    }
    if (!WriteExact(&count, sizeof(count)) || !WriteExact(results.data(), results.size())) return 67;
    if (std::fflush(stdout) != 0) return 68;
  }
}

int SpawnChild() {
  wchar_t self[MAX_PATH]{};
  GetModuleFileNameW(nullptr, self, MAX_PATH);
  std::wstring command = L"\"" + std::wstring(self) + L"\" sleep 120000";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
      self, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
      nullptr, nullptr, &startup, &process)) {
    return 50;
  }
  std::printf("%lu\n", process.dwProcessId);
  std::fflush(stdout);
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, 120000);
  CloseHandle(process.hProcess);
  return 0;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  std::wstring mode = Arg(argc, argv, 1);
  if (mode == L"exit") return 0;
  if (mode == L"write") return WriteFileProbe(Arg(argc, argv, 2));
  if (mode == L"read") return ReadFileProbe(Arg(argc, argv, 2));
  if (mode == L"tcp") return TcpProbe(Arg(argc, argv, 2), _wtoi(Arg(argc, argv, 3).c_str()));
  if (mode == L"pipe") return PipeProbe(Arg(argc, argv, 2));
  if (mode == L"reparse-attributes") return ReparseProbe(argc, argv);
  if (mode == L"reparse-daemon") return ReparseDaemon();
  if (mode == L"spawn-child") return SpawnChild();
  if (mode == L"sleep") {
    Sleep(static_cast<DWORD>(_wtoi(Arg(argc, argv, 2).c_str())));
    return 0;
  }
  return 2;
}
