#define MyAppName "WordVault"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

[Setup]
AppId={{B7E3D2A1-5C4F-4E8B-9A61-2D7F0C3A8E44}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=WordVault
DefaultDirName={autopf}\WordVault
DefaultGroupName=WordVault
DisableProgramGroupPage=yes
OutputDir=..\dist-windows
OutputBaseFilename=WordVault-Setup-{#MyAppVersion}
SetupIconFile=WordVault.ico
UninstallDisplayIcon={app}\WordVault.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
MinVersion=10.0
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64

[Files]
Source: "..\dist-single\index.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "WordVault.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "WordVault.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\WordVault"; Filename: "{app}\WordVault.exe"; IconFilename: "{app}\WordVault.ico"
Name: "{group}\卸载 WordVault"; Filename: "{uninstallexe}"
Name: "{autodesktop}\WordVault"; Filename: "{app}\WordVault.exe"; IconFilename: "{app}\WordVault.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: unchecked

[Run]
Filename: "{app}\WordVault.exe"; Description: "启动 WordVault"; Flags: nowait postinstall skipifsilent
