/* Piko's small, Unicode Windows launcher. The companion .shim uses Scoop's
 * path/args shape but is deliberately restricted to the local Piko dispatcher.
 * No Shell, PATH search, CRT, application code, or writable DLL search is used. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

static WCHAR modulePath[32768], target[32768], commandLine[32768];
static CHAR metadata[512], expected[512];
static int length(const WCHAR *s) { int n=0; while(s[n]) n++; return n; }
static void error(const CHAR *message, DWORD code) {
  HANDLE h=GetStdHandle(STD_ERROR_HANDLE); DWORD n=0, bytes=0;
  while(message[n]) n++; WriteFile(h,message,n,&bytes,0); ExitProcess(code);
}
static BOOL WINAPI consoleControl(DWORD type) { return type==CTRL_C_EVENT || type==CTRL_BREAK_EVENT; }
static void append(WCHAR **p, WCHAR *end, const WCHAR *s) {
  while(*s) { if(*p>=end) error("Piko shim: command line too long\r\n",87); *(*p)++=*s++; }
  **p=0;
}
void WINAPI shimMain(void) {
  DWORD size=GetModuleFileNameW(0,modulePath,32768);
  if(!size || size>=32760) error("Piko shim: invalid launcher location\r\n",87);
  int leaf=(int)size; while(leaf>0 && modulePath[leaf-1]!=L'\\' && modulePath[leaf-1]!=L'/') leaf--;
  int nameEnd=(int)size-4;
  if(nameEnd<=leaf || nameEnd-leaf>80 || modulePath[nameEnd]!=L'.' || (modulePath[nameEnd+1]|32)!=L'e' || (modulePath[nameEnd+2]|32)!=L'x' || (modulePath[nameEnd+3]|32)!=L'e') error("Piko shim: invalid command filename\r\n",87);
  WCHAR name[81]; int j=0;
  for(int i=leaf;i<nameEnd;i++) { WCHAR c=modulePath[i]; if(c>=L'A' && c<=L'Z') c+=32;
    if(!((c>=L'a' && c<=L'z') || (c>=L'0' && c<=L'9') || (i>leaf && (c==L'.'||c==L'_'||c==L'+'||c==L'-')))) error("Piko shim: unsafe command name\r\n",87);
    name[j++]=c;
  } name[j]=0;
  int dirEnd=leaf-1, dirStart=dirEnd; while(dirStart>0 && modulePath[dirStart-1]!=L'\\' && modulePath[dirStart-1]!=L'/') dirStart--;
  const WCHAR *shims=L"shims"; if(dirEnd-dirStart!=5) error("Piko shim: expected shims directory\r\n",87);
  for(int i=0;i<5;i++) if((modulePath[dirStart+i]|32)!=shims[i]) error("Piko shim: expected shims directory\r\n",87);
  WCHAR *t=target; for(int i=0;i<dirStart;i++) *t++=modulePath[i];
  append(&t,target+32766,L"apps\\piko\\piko.exe");
  modulePath[nameEnd+1]=L's';modulePath[nameEnd+2]=L'h';modulePath[nameEnd+3]=L'i';modulePath[nameEnd+4]=L'm';modulePath[nameEnd+5]=0;
  HANDLE file=CreateFileW(modulePath,GENERIC_READ,FILE_SHARE_READ,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,0);
  if(file==INVALID_HANDLE_VALUE) error("Piko shim: missing .shim configuration\r\n",2);
  BY_HANDLE_FILE_INFORMATION info; DWORD count=0;
  if(!GetFileInformationByHandle(file,&info) || (info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)) || info.nFileSizeHigh || info.nFileSizeLow>=512 || !ReadFile(file,metadata,511,&count,0)) { CloseHandle(file);error("Piko shim: unsafe .shim configuration\r\n",87); }
  CloseHandle(file);
  const CHAR *prefix="path = \"..\\apps\\piko\\piko.exe\"\r\nargs = ";int n=0;while(*prefix)expected[n++]=*prefix++;
  BOOL piko=j==4&&name[0]==L'p'&&name[1]==L'i'&&name[2]==L'k'&&name[3]==L'o';
  if(!piko) { const CHAR *dispatch="__shim ";while(*dispatch)expected[n++]=*dispatch++;for(int i=0;i<j;i++)expected[n++]=(CHAR)name[i]; }
  expected[n++]='\r';expected[n++]='\n';
  if(count!=(DWORD)n)error("Piko shim: unrecognized .shim configuration\r\n",87);
  for(int i=0;i<n;i++)if(metadata[i]!=expected[i])error("Piko shim: .shim target or command changed\r\n",87);
  // Preserve Windows' original argument tail exactly, including empty args,
  // quotes, Unicode and backslashes. Never reconstruct through cmd.exe.
  const WCHAR *tail=GetCommandLineW();BOOL quoted=FALSE;
  while(*tail){if(*tail==L'\"')quoted=!quoted;else if(!quoted&&(*tail==L' '||*tail==L'\t'))break;tail++;}
  while(*tail==L' '||*tail==L'\t')tail++;
  WCHAR *out=commandLine;append(&out,commandLine+32766,L"\"");append(&out,commandLine+32766,target);append(&out,commandLine+32766,L"\"");
  if(!piko){append(&out,commandLine+32766,L" __shim ");append(&out,commandLine+32766,name);}
  if(*tail){append(&out,commandLine+32766,L" ");append(&out,commandLine+32766,tail);}
  STARTUPINFOW startup={0};startup.cb=sizeof(startup);GetStartupInfoW(&startup);
  PROCESS_INFORMATION process={0};
  if(!CreateProcessW(target,commandLine,0,0,TRUE,0,0,0,&startup,&process))error("Piko shim: unable to launch local Piko\r\n",GetLastError());
  CloseHandle(process.hThread);SetConsoleCtrlHandler(consoleControl,TRUE);
  WaitForSingleObject(process.hProcess,INFINITE);DWORD code=1;GetExitCodeProcess(process.hProcess,&code);CloseHandle(process.hProcess);ExitProcess(code);
}
