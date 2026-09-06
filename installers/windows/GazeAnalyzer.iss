; Inno Setup script for the Windows installer.
;
; Why not Tauri's own bundlers: NSIS and WiX both fail on a payload larger than
; about 2 GB (tauri-apps/tauri#7372, open upstream), and the CUDA build of torch
; puts the app at roughly 5 GB. A single Inno setup.exe carries up to 4.2 GB of
; compressed data, which this fits into with room to spare.
;
; Build, on Windows, from the repository root:
;
;     cd backend
;     venv\Scripts\activate
;     pyinstaller --clean --noconfirm gazeanalyzer-backend.spec
;     cd ..
;     npm run tauri build -- --no-bundle
;     iscc installers\windows\GazeAnalyzer.iss
;
; `--no-bundle` skips NSIS/WiX (which would fail anyway); the build still writes
; the complete tree to src-tauri\target\release\ — the exe plus the backend\
; resource directory next to it — because tauri-build copies resources there
; regardless of bundling. That tree is what this script packages.
;
; Output: installers\windows\Output\GazeAnalyzer-<version>-x64-setup.exe
; Requires Inno Setup 6.3+ (for ArchitecturesAllowed=x64compatible).

#define AppName "GazeAnalyzer"
#define AppVersion "0.1.0"
#define AppExeName "tauri-app.exe"
#define ReleaseDir "..\..\src-tauri\target\release"

[Setup]
; Never change AppId — it is how Windows recognises an existing install when
; upgrading or uninstalling.
AppId={{B1C0DB17-219B-44CC-BD53-560FF5E6CB77}
AppName={#AppName}
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#AppExeName}
SetupIconFile=..\..\src-tauri\icons\icon.ico
OutputDir=Output
OutputBaseFilename={#AppName}-{#AppVersion}-x64-setup
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; ~5 GB of CUDA libraries: solid LZMA2 gets that down to roughly 3 GB, at the
; cost of a long compile. Drop to lzma2/fast while iterating on the script.
Compression=lzma2/max
SolidCompression=yes
; Program Files needs elevation, but let the user install per-user instead.
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#ReleaseDir}\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}\backend\*"; DestDir: "{app}\backend"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; WebView2 is present on Windows 11 and current Windows 10; install it only when
; it is genuinely missing. The bootstrapper is downloaded in NextButtonClick.
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing the WebView2 runtime..."; Check: NeedsWebView2; Flags: waituntilterminated
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  { The Evergreen WebView2 Runtime's client id, per Microsoft's distribution docs. }
  WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  { Evergreen bootstrapper (~2 MB) — the permanent fwlink from the same docs. }
  WebView2BootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

var
  DownloadPage: TDownloadWizardPage;

{ A per-machine install writes under HKLM, a per-user one under HKCU. Either
  counts, but only with a real version — the key can exist holding 0.0.0.0. }
function WebView2Installed: Boolean;
var
  Version: String;
begin
  if not RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) then
    if not RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) then
      if not RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId, 'pv', Version) then
        Version := '';

  Result := (Version <> '') and (Version <> '0.0.0.0');
end;

function NeedsWebView2: Boolean;
begin
  Result := not WebView2Installed;
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), nil);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  if (CurPageID = wpReady) and NeedsWebView2 then
  begin
    DownloadPage.Clear;
    DownloadPage.Add(WebView2BootstrapperUrl, 'MicrosoftEdgeWebview2Setup.exe', '');
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
        Result := True;
      except
        SuppressibleMsgBox(AddPeriod(GetExceptionMessage), mbCriticalError, MB_OK, IDOK);
        Result := False;
      end;
    finally
      DownloadPage.Hide;
    end;
  end
  else
    Result := True;
end;
