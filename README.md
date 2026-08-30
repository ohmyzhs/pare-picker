# Pair Picker

같은 번호의 후보 이미지(`-01`~`-08`) 중 하나를 선택해 숫자 파일명으로 확정하는 데스크톱 앱입니다. 번호별 후보는 1장부터 최대 8장까지 지원하며, 여러 장 중 선택하지 않은 이미지는 운영체제 휴지통으로 보냅니다.

## 2560×1440 JPEG 자동 개선

선택이 끝난 폴더를 다시 열거나 마지막 후보 선택을 마치면 `2560×1440 JPEG 자동 개선`을 실행할 수 있습니다.

- `001.jpeg`처럼 숫자 이름인 선택 완료 이미지만 처리합니다.
- Real-ESRGAN의 애니메이션 전용 네이티브 2x 모델로 먼저 업스케일합니다.
- 결과를 2560×1440으로 중앙 크롭하고 밝기·대비·채도·선명도를 약하게 자동 보정합니다.
- 원본은 덮어쓰지 않고 `업스케일_2560x1440` 폴더에 JPEG 품질 94로 저장합니다.
- 같은 이름의 출력 폴더가 있으면 `_2`, `_3`처럼 새 폴더를 만들어 기존 결과도 보존합니다.

Apple Silicon Mac과 Windows x64용 Real-ESRGAN 실행 파일 및 모델이 앱 자원에 포함됩니다. GPU에서 Vulkan을 지원해야 하며 macOS에서는 MoltenVK를 통해 Metal을 사용합니다.

포함된 Real-ESRGAN 및 ncnn 구성 요소의 라이선스 전문은 `src-tauri/licenses`에 있습니다.

## 단일 이미지·다중 이미지 직접 업스케일

상단의 `이미지 업스케일` 탭을 선택하면 폴더 전체를 열지 않고 필요한 파일만 처리할 수 있습니다.

- 큰 드롭 영역에 PNG, JPG, JPEG 파일 한 장 또는 여러 장을 동시에 놓습니다.
- `파일 선택` 버튼으로 여러 파일을 직접 고를 수도 있습니다.
- 업로드된 미리보기에서 필요 없는 파일을 제거한 뒤 `2560×1440 JPEG 자동 개선 시작`을 누릅니다.
- 결과는 첫 번째로 올린 이미지가 있는 폴더의 `업스케일_2560x1440` 폴더에 저장됩니다.
- 기존 폴더가 있으면 `_2`, `_3`처럼 새 폴더를 만들며, 입력 파일은 변경하지 않습니다.

## 배포 빌드와 자동 버전업

현재 버전은 `package.json`을 기준으로 관리하며, 배포 명령을 실행할 때마다 패치 버전이 자동으로 올라갑니다. 일반 `npm run build`는 버전을 올리지 않습니다.

macOS 배포:

```bash
npm run build:mac
```

Windows 배포:

```bash
npm run build:windows
```

버전은 `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, 앱 화면에 함께 반영됩니다.

## Windows 11 빌드

Windows 11 컴퓨터에서 다음 준비물을 설치합니다.

- [Node.js LTS](https://nodejs.org/)
- [Rust](https://www.rust-lang.org/tools/install)
- Visual Studio 2022 Build Tools의 **Desktop development with C++** 워크로드와 Windows SDK

프로젝트 폴더에서 한 번만 의존성을 설치한 뒤 Windows용 실행 파일을 만듭니다.

```powershell
npm install
npm run build:windows
```

Real-ESRGAN 실행 파일과 모델을 함께 설치해야 하므로 Windows에서는 NSIS 설치 프로그램을 만듭니다. 결과는 다음 폴더에 생성됩니다.

```text
src-tauri\target\release\bundle\nsis\
```

생성된 설치 프로그램을 이용해야 Real-ESRGAN 실행 파일, 2x 모델, Windows OpenMP 런타임이 빠짐없이 함께 설치됩니다. `pair-picker.exe` 하나만 복사하면 자동 개선 기능은 동작하지 않습니다.

Windows 11에는 앱 화면을 표시하는 WebView2 런타임이 기본으로 포함되어 있습니다. 기업용으로 배포할 경우에는 코드 서명을 추가하면 SmartScreen 경고를 줄일 수 있습니다. 아주 오래된 Windows 버전 또는 WebView2가 제거된 환경은 지원 대상이 아닙니다.
