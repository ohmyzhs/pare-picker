# Pair Picker

같은 번호의 후보 이미지(`-01`~`-08`) 중 하나를 선택해 숫자 파일명으로 확정하는 데스크톱 앱입니다. 번호별 후보는 2장부터 최대 8장까지 지원하며, 선택하지 않은 이미지는 운영체제 휴지통으로 보냅니다.

## Windows 11 단일 실행 파일 빌드

Windows 11 컴퓨터에서 다음 준비물을 설치합니다.

- [Node.js LTS](https://nodejs.org/)
- [Rust](https://www.rust-lang.org/tools/install)
- Visual Studio 2022 Build Tools의 **Desktop development with C++** 워크로드와 Windows SDK

프로젝트 폴더에서 한 번만 의존성을 설치한 뒤 Windows용 실행 파일을 만듭니다.

```powershell
npm install
npm run build:windows
```

완성된 단일 배포 파일은 다음 위치에 생성됩니다.

```text
src-tauri\target\release\pair-picker.exe
```

`pair-picker.exe` 하나만 다른 Windows 11 PC로 복사해 바로 실행하면 됩니다. 설치나 관리자 권한은 필요하지 않으며, 시작 메뉴 바로가기가 필요하면 사용자가 직접 바로가기를 만들 수 있습니다.

Windows 11에는 앱 화면을 표시하는 WebView2 런타임이 기본으로 포함되어 있습니다. 기업용으로 배포할 경우에는 코드 서명을 추가하면 SmartScreen 경고를 줄일 수 있습니다. 아주 오래된 Windows 버전 또는 WebView2가 제거된 환경은 지원 대상이 아닙니다.
