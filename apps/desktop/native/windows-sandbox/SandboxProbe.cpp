#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <string>
#include <cstdio>
#include <cstdlib>

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
  if (mode == L"spawn-child") return SpawnChild();
  if (mode == L"sleep") {
    Sleep(static_cast<DWORD>(_wtoi(Arg(argc, argv, 2).c_str())));
    return 0;
  }
  return 2;
}
