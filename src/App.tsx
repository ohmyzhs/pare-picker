import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import ScriptSplitter from "./ScriptSplitter";

type ImageFile = {
  path: string;
  fileName: string;
};

type ImageGroup = {
  id: string;
  images: ImageFile[];
};

type ScanResult = {
  groups: ImageGroup[];
  skippedCount: number;
  readyToRenameCount: number;
  readyToEnhanceCount: number;
};

type NormalizeResult = {
  renamedCount: number;
  skippedCount: number;
};

type EnhanceResult = {
  processedCount: number;
  outputDir: string;
  targetWidth: number;
  targetHeight: number;
};

type EnhanceProgress = {
  stage: string;
  current: number;
  total: number;
  percent: number;
  message: string;
};

type Preview = {
  groupId: string;
  sources: string[];
};

type Tool = "image" | "upscale" | "script";

type ScriptDrop = {
  id: number;
  path: string;
};

type UpscaleFile = ImageFile & {
  source: string;
};

const isUsablePath = (value: string) => value.trim().length > 0;
const isImagePath = (value: string) => /\.(?:png|jpe?g)$/i.test(value);
const APP_VERSION = "v0.3.2";

function decodeDroppedPath(value: string) {
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      return "";
    }
  }

  return value;
}

function filePathsFromDrop(value: string) {
  return Array.from(
    new Set(
      value
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry && !entry.startsWith("#"))
        .map(decodeDroppedPath)
        .filter(Boolean),
    ),
  );
}

function fileNameFromPath(value: string) {
  return value.split(/[\\/]/).pop() || value;
}

export default function App() {
  const [activeTool, setActiveTool] = useState<Tool>("image");
  const [scriptDroppedFile, setScriptDroppedFile] = useState<ScriptDrop | null>(null);
  const [upscaleFiles, setUpscaleFiles] = useState<UpscaleFile[]>([]);
  const [upscalePreviews, setUpscalePreviews] = useState<Record<string, string>>({});
  const [isUpscaleLoading, setIsUpscaleLoading] = useState(false);
  const [upscaleResult, setUpscaleResult] = useState<EnhanceResult | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [groups, setGroups] = useState<ImageGroup[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [readyToRenameCount, setReadyToRenameCount] = useState(0);
  const [readyToEnhanceCount, setReadyToEnhanceCount] = useState(0);
  const [legacyRenamedCount, setLegacyRenamedCount] = useState<number | null>(null);
  const [pairIndex, setPairIndex] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [enhanceProgress, setEnhanceProgress] = useState<EnhanceProgress | null>(null);
  const [enhanceResult, setEnhanceResult] = useState<EnhanceResult | null>(null);
  const [error, setError] = useState("");

  const activeGroup = groups[pairIndex];
  const progress = groups.length === 0 ? 0 : (pairIndex / groups.length) * 100;
  const isFinished = groups.length > 0 && pairIndex >= groups.length;
  const enhanceableCount = readyToEnhanceCount + completedCount;

  const loadFolder = useCallback(async (path: string) => {
    if (!isUsablePath(path) || isEnhancing) return;

    setIsLoading(true);
    setError("");
    setPreview(null);

    try {
      const result = await invoke<ScanResult>("scan_image_pairs", { folderPath: path.trim() });
      setFolderPath(path.trim());
      setGroups(result.groups);
      setSkippedCount(result.skippedCount);
      setReadyToRenameCount(result.readyToRenameCount);
      setReadyToEnhanceCount(result.readyToEnhanceCount);
      setLegacyRenamedCount(null);
      setEnhanceResult(null);
      setEnhanceProgress(null);
      setPairIndex(0);
      setCompletedCount(0);

      if (result.groups.length === 0 && result.readyToRenameCount === 0 && result.readyToEnhanceCount === 0) {
        setError("후보가 1~8장인 번호별 이미지를 찾지 못했습니다.");
      }
    } catch (reason) {
      setGroups([]);
      setReadyToRenameCount(0);
      setReadyToEnhanceCount(0);
      setLegacyRenamedCount(null);
      setEnhanceResult(null);
      setEnhanceProgress(null);
      setPairIndex(0);
      setCompletedCount(0);
      setError(String(reason));
    } finally {
      setIsLoading(false);
    }
  }, [isEnhancing]);

  const chooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "후보 이미지가 있는 폴더 선택",
    });

    if (typeof selected === "string") {
      await loadFolder(selected);
    }
  }, [loadFolder]);

  const loadUpscaleFiles = useCallback(async (paths: string[]) => {
    if (isEnhancing) return;

    const imagePaths = Array.from(new Set(paths.filter(isImagePath)));
    if (imagePaths.length === 0) {
      setError("PNG, JPG, JPEG 이미지 파일을 하나 이상 드롭해 주세요.");
      return;
    }

    setIsUpscaleLoading(true);
    setError("");
    setUpscaleResult(null);
    try {
      const sources = await Promise.all(
        imagePaths.map((path) => invoke<string>("load_image_data_url", { path })),
      );
      setUpscaleFiles(
        imagePaths.map((path, index) => ({
          path,
          fileName: fileNameFromPath(path),
          source: sources[index],
        })),
      );
      setUpscalePreviews(Object.fromEntries(imagePaths.map((path, index) => [path, sources[index]])));
    } catch (reason) {
      setUpscaleFiles([]);
      setUpscalePreviews({});
      setError(`이미지를 불러오지 못했습니다: ${String(reason)}`);
    } finally {
      setIsUpscaleLoading(false);
    }
  }, [isEnhancing]);

  const chooseUpscaleFiles = useCallback(async () => {
    const selected = await open({
      directory: false,
      multiple: true,
      title: "업스케일할 이미지 선택",
      filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg"] }],
    });
    const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    if (paths.length > 0) await loadUpscaleFiles(paths);
  }, [loadUpscaleFiles]);

  const removeUpscaleFile = useCallback((path: string) => {
    setUpscaleFiles((files) => files.filter((file) => file.path !== path));
    setUpscalePreviews((previews) => {
      const next = { ...previews };
      delete next[path];
      return next;
    });
    setUpscaleResult(null);
  }, []);

  const clearUpscaleFiles = useCallback(() => {
    setUpscaleFiles([]);
    setUpscalePreviews({});
    setUpscaleResult(null);
    setError("");
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<EnhanceProgress>("enhance-progress", (event) => {
      setEnhanceProgress(event.payload);
    }).then((listener) => {
      unlisten = listener;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (isEnhancing) return;
        if (event.payload.type === "drop" && event.payload.paths.length > 0) {
          if (activeTool === "image") {
            void loadFolder(event.payload.paths[0]);
          } else if (activeTool === "upscale") {
            void loadUpscaleFiles(event.payload.paths);
          } else {
            setScriptDroppedFile({ id: Date.now(), path: event.payload.paths[0] });
          }
        }
      })
      .then((listener) => {
        unlisten = listener;
      });

    return () => unlisten?.();
  }, [activeTool, isEnhancing, loadFolder, loadUpscaleFiles]);

  useEffect(() => {
    if (!activeGroup) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setPreview(null);
    setError("");

    void Promise.all(
      activeGroup.images.map((image) => invoke<string>("load_image_data_url", { path: image.path })),
    )
      .then((sources) => {
        if (!cancelled) setPreview({ groupId: activeGroup.id, sources });
      })
      .catch((reason) => {
        if (!cancelled) setError(`이미지를 불러오지 못했습니다: ${String(reason)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [activeGroup]);

  const selectImage = useCallback(
    async (keep: ImageFile) => {
      if (!activeGroup || isDeleting || !preview) return;

      setIsDeleting(true);
      setError("");
      const discardPaths = activeGroup.images
        .filter((image) => image.path !== keep.path)
        .map((image) => image.path);

      try {
        await invoke("finalize_selection", {
          keepPath: keep.path,
          discardPaths,
        });
        setCompletedCount((count) => count + 1);
        setPairIndex((index) => index + 1);
      } catch (reason) {
        setError(`선택을 정리하지 못했습니다: ${String(reason)}`);
      } finally {
        setIsDeleting(false);
      }
    },
    [activeGroup, isDeleting, preview],
  );

  const normalizeRemainingImages = useCallback(async () => {
    if (!folderPath || isDeleting || readyToRenameCount === 0) return;

    setIsDeleting(true);
    setError("");
    try {
      const result = await invoke<NormalizeResult>("normalize_remaining_images", { folderPath });
      setReadyToRenameCount(0);
      setReadyToEnhanceCount((count) => count + result.renamedCount);
      setSkippedCount((count) => Math.max(0, count - result.renamedCount));
      setLegacyRenamedCount(result.renamedCount);
    } catch (reason) {
      setError(`파일명을 정리하지 못했습니다: ${String(reason)}`);
    } finally {
      setIsDeleting(false);
    }
  }, [folderPath, isDeleting, readyToRenameCount]);

  const enhanceSelectedImages = useCallback(async () => {
    if (!folderPath || isEnhancing || enhanceableCount === 0) return;

    setIsEnhancing(true);
    setError("");
    setEnhanceResult(null);
    setEnhanceProgress({
      stage: "preparing",
      current: 0,
      total: enhanceableCount,
      percent: 0,
      message: "자동 개선 작업을 준비하고 있습니다…",
    });
    try {
      const result = await invoke<EnhanceResult>("enhance_selected_images", { folderPath });
      setEnhanceResult(result);
    } catch (reason) {
      setError(`이미지 자동 개선에 실패했습니다: ${String(reason)}`);
    } finally {
      setIsEnhancing(false);
    }
  }, [enhanceableCount, folderPath, isEnhancing]);

  const enhanceDroppedImages = useCallback(async () => {
    if (upscaleFiles.length === 0 || isEnhancing) return;

    setIsEnhancing(true);
    setError("");
    setUpscaleResult(null);
    setEnhanceProgress({
      stage: "preparing",
      current: 0,
      total: upscaleFiles.length,
      percent: 0,
      message: "드롭한 이미지의 자동 개선을 준비하고 있습니다…",
    });
    try {
      const result = await invoke<EnhanceResult>("enhance_selected_files", {
        filePaths: upscaleFiles.map((file) => file.path),
      });
      setUpscaleResult(result);
    } catch (reason) {
      setError(`이미지 자동 개선에 실패했습니다: ${String(reason)}`);
    } finally {
      setIsEnhancing(false);
    }
  }, [isEnhancing, upscaleFiles]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeTool !== "image") return;
      const imageIndex = event.key === "ArrowLeft" ? 0 : event.key === "ArrowRight" ? 1 : Number(event.key) - 1;
      const image = activeGroup?.images[imageIndex];
      if (image) void selectImage(image);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeGroup, activeTool, selectImage]);

  const statusMessage = useMemo(() => {
    if (isLoading) return "폴더에서 번호별 후보 이미지를 찾고 있습니다…";
    if (isDeleting) return "선택 결과를 정리하고 있습니다…";
    if (isEnhancing) return enhanceProgress?.message ?? "AI 업스케일과 자동 개선을 적용하고 있습니다…";
    if (enhanceResult) return `${enhanceResult.processedCount}장 자동 개선을 완료했습니다.`;
    if (legacyRenamedCount !== null) return `${legacyRenamedCount}장의 파일명을 정리했습니다.`;
    if (isFinished) return "모든 번호의 후보 이미지를 정리했습니다.";
    if (activeGroup) return `${pairIndex + 1} / ${groups.length} 번호 · 후보 ${activeGroup.images.length}장`;
    return "폴더를 선택하거나 여기로 드래그하세요.";
  }, [activeGroup, enhanceProgress?.message, enhanceResult, groups.length, isDeleting, isEnhancing, isFinished, isLoading, legacyRenamedCount, pairIndex]);

  const acceptTextDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (isEnhancing) return;
    const droppedPaths = filePathsFromDrop(
      event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"),
    );
    if (droppedPaths.length === 0) return;
    if (activeTool === "image") {
      void loadFolder(droppedPaths[0]);
    } else if (activeTool === "upscale") {
      void loadUpscaleFiles(droppedPaths);
    } else {
      setScriptDroppedFile({ id: Date.now(), path: droppedPaths[0] });
    }
  };

  return (
    <main className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={acceptTextDrop}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PP</span>
          <div>
            <h1>Pair Picker <span className="app-version">{APP_VERSION}</span></h1>
            <p>{activeTool === "image" ? "후보 중 남길 한 장을 선택하세요" : activeTool === "upscale" ? "한 장 또는 여러 장을 바로 업스케일합니다" : "대본을 단락 단위로 나눕니다"}</p>
          </div>
        </div>
        <nav className="tool-tabs" aria-label="도구 선택">
          <button className={activeTool === "image" ? "active" : ""} type="button" disabled={isEnhancing} onClick={() => setActiveTool("image")}>사진 선택</button>
          <button className={activeTool === "upscale" ? "active" : ""} type="button" disabled={isEnhancing} onClick={() => { setError(""); setActiveTool("upscale"); }}>이미지 업스케일</button>
          <button className={activeTool === "script" ? "active" : ""} type="button" disabled={isEnhancing} onClick={() => setActiveTool("script")}>대본 분할</button>
        </nav>
        {activeTool === "image" && <div className="path-picker">
          <input
            aria-label="이미지 폴더 경로"
            value={folderPath}
            disabled={isEnhancing}
            placeholder="이미지 폴더 경로를 붙여넣거나 드래그"
            onChange={(event) => setFolderPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void loadFolder(folderPath);
            }}
          />
          <button type="button" onClick={() => void loadFolder(folderPath)} disabled={!isUsablePath(folderPath) || isLoading || isEnhancing}>
            열기
          </button>
          <button className="folder-button" type="button" disabled={isEnhancing} onClick={() => void chooseFolder()}>
            폴더 선택
          </button>
        </div>}
      </header>

      {activeTool === "image" ? <>
      <section className="status-row" aria-live="polite">
        <div className="status-copy">
          <span className={`status-dot ${isDeleting || isLoading || isEnhancing ? "working" : ""}`} />
          <span>{statusMessage}</span>
          {skippedCount > 0 && <small>후보가 1~8장이 아닌 번호 또는 형식이 맞지 않는 이미지 {skippedCount}개는 건드리지 않습니다.</small>}
        </div>
        {isEnhancing && enhanceProgress ? (
          <div className="progress-wrap" aria-label={`자동 개선 진행률 ${enhanceProgress.percent}%`}>
            <span>{enhanceProgress.current} / {enhanceProgress.total}장 · {enhanceProgress.percent}%</span>
            <div className="progress-track"><div className="progress-value" style={{ width: `${enhanceProgress.percent}%` }} /></div>
          </div>
        ) : groups.length > 0 && (
          <div className="progress-wrap" aria-label={`진행률 ${Math.round(progress)}%`}>
            <span>{completedCount}장 선택 · {groups.length - pairIndex}개 번호 남음</span>
            <div className="progress-track"><div className="progress-value" style={{ width: `${progress}%` }} /></div>
          </div>
        )}
      </section>

      {error && <div className="error-message" role="alert">{error}</div>}

      <section className={`pair-stage image-count-${activeGroup?.images.length ?? 0}`} aria-busy={isDeleting || isLoading || isEnhancing}>
        {enhanceResult ? (
          <div className="complete-state enhance-complete-state">
            <span className="complete-icon">✓</span>
            <h2>자동 개선이 완료되었습니다</h2>
          <p>{enhanceResult.processedCount}장을 {enhanceResult.targetWidth}×{enhanceResult.targetHeight} JPEG로 만들었습니다. 원본은 그대로 보존했습니다.</p>
            <div className="output-path" title={enhanceResult.outputDir}>{enhanceResult.outputDir}</div>
            <button type="button" onClick={() => void chooseFolder()}>다른 폴더 선택</button>
          </div>
        ) : isFinished ? (
          <div className="complete-state">
            <span className="complete-icon">✓</span>
            <h2>정리가 완료되었습니다</h2>
            <p>{completedCount}개 번호에서 선택한 이미지를 남기고, 나머지는 휴지통으로 옮겼습니다. 선택 완료 이미지 {enhanceableCount}장을 AI 2x 처리한 뒤 2560×1440 JPEG로 자동 개선할 수 있습니다.</p>
            <div className="complete-actions">
              <button type="button" disabled={isEnhancing} onClick={() => void enhanceSelectedImages()}>2560×1440 JPEG 자동 개선</button>
              <button className="secondary-button" type="button" disabled={isEnhancing} onClick={() => void chooseFolder()}>다른 폴더 선택</button>
            </div>
          </div>
        ) : activeGroup ? (
          activeGroup.images.map((image, index) => (
            <ImageCanvas
              key={image.path}
              image={image}
              source={preview?.groupId === activeGroup.id ? preview.sources[index] : undefined}
              side={index + 1}
              disabled={isDeleting || !preview}
              onSelect={() => void selectImage(image)}
            />
          ))
        ) : readyToRenameCount > 0 ? (
          <div className="complete-state">
            <span className="complete-icon">↺</span>
            <h2>선택 완료된 이미지 {readyToRenameCount}장을 찾았습니다</h2>
            <p>이전 버전에서 남은 <code>-1</code>/<code>-2</code> 또는 <code>-01</code>/<code>-02</code> 접미사를 지웁니다. 이미 숫자 이름의 파일이 있으면 덮어쓰지 않습니다.</p>
            <button type="button" onClick={() => void normalizeRemainingImages()} disabled={isDeleting}>파일명 정리</button>
          </div>
        ) : legacyRenamedCount !== null ? (
          <div className="complete-state">
            <span className="complete-icon">✓</span>
            <h2>파일명 정리가 완료되었습니다</h2>
            <p>{legacyRenamedCount}장을 <code>001.jpeg</code>처럼 숫자 파일명으로 바꿨습니다. 이제 {enhanceableCount}장을 2560×1440 JPEG로 자동 개선할 수 있습니다.</p>
            <div className="complete-actions">
              <button type="button" disabled={isEnhancing} onClick={() => void enhanceSelectedImages()}>2560×1440 JPEG 자동 개선</button>
              <button className="secondary-button" type="button" disabled={isEnhancing} onClick={() => void chooseFolder()}>다른 폴더 선택</button>
            </div>
          </div>
        ) : readyToEnhanceCount > 0 ? (
          <div className="complete-state">
            <span className="complete-icon">↑</span>
            <h2>선택 완료 이미지 {readyToEnhanceCount}장을 찾았습니다</h2>
            <p>숫자 파일명 이미지만 대상으로 애니메이션 전용 Real-ESRGAN 2x 모델과 약한 밝기·대비·채도·선명도 보정을 적용합니다.</p>
            <div className="complete-actions">
              <button type="button" disabled={isEnhancing} onClick={() => void enhanceSelectedImages()}>2560×1440 JPEG 자동 개선</button>
              <button className="secondary-button" type="button" disabled={isEnhancing} onClick={() => void chooseFolder()}>다른 폴더 선택</button>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">↙</span>
            <h2>이미지 폴더를 놓아주세요</h2>
            <p><code>-01</code>부터 <code>-08</code>까지 같은 번호의 PNG, JPG, JPEG 파일을 묶습니다. 한 번호에 후보가 한 장만 있어도 표시하고 이름을 정리할 수 있습니다.</p>
            <button type="button" onClick={() => void chooseFolder()}>폴더 선택</button>
          </div>
        )}
      </section>

      <footer>
        <span>클릭한 이미지는 <code>001.jpeg</code>처럼 이름을 정리하고, 같은 번호의 나머지 후보는 휴지통으로 이동합니다.</span>
        <span>단축키: <kbd>1</kbd>~<kbd>8</kbd> · <kbd>←</kbd> 1번 · <kbd>→</kbd> 2번</span>
      </footer>
      </> : activeTool === "upscale" ? <UpscaleWorkspace
        files={upscaleFiles}
        previews={upscalePreviews}
        isLoading={isUpscaleLoading}
        isEnhancing={isEnhancing}
        progress={enhanceProgress}
        result={upscaleResult}
        error={error}
        onDrop={acceptTextDrop}
        onChoose={() => void chooseUpscaleFiles()}
        onClear={clearUpscaleFiles}
        onRemove={removeUpscaleFile}
        onEnhance={() => void enhanceDroppedImages()}
      /> : <ScriptSplitter
        droppedFile={scriptDroppedFile}
        onDropConsumed={() => setScriptDroppedFile(null)}
      />}
    </main>
  );
}

type ImageCanvasProps = {
  image: ImageFile;
  source?: string;
  side: number;
  disabled: boolean;
  onSelect: () => void;
};

function ImageCanvas({ image, source, side, disabled, onSelect }: ImageCanvasProps) {
  return (
    <button
      className="image-canvas"
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-label={`${side}번 이미지 ${image.fileName} 선택하고 남기기`}
    >
      <div className="canvas-heading"><span>{side}번</span><strong>{image.fileName}</strong></div>
      {source ? <img src={source} alt={image.fileName} /> : <span className="image-loader" />}
      <div className="keep-overlay"><span>이 이미지 남기기</span><small>클릭</small></div>
    </button>
  );
}

type UpscaleWorkspaceProps = {
  files: UpscaleFile[];
  previews: Record<string, string>;
  isLoading: boolean;
  isEnhancing: boolean;
  progress: EnhanceProgress | null;
  result: EnhanceResult | null;
  error: string;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
  onChoose: () => void;
  onClear: () => void;
  onRemove: (path: string) => void;
  onEnhance: () => void;
};

function UpscaleWorkspace({
  files,
  previews,
  isLoading,
  isEnhancing,
  progress,
  result,
  error,
  onDrop,
  onChoose,
  onClear,
  onRemove,
  onEnhance,
}: UpscaleWorkspaceProps) {
  return (
    <section className="upscale-tool" aria-busy={isLoading || isEnhancing}>
      <div className="upscale-toolbar">
        <div>
          <span className="eyebrow">DIRECT IMAGE ENHANCEMENT</span>
          <h2>이미지 업스케일</h2>
          <p>폴더 전체를 열지 않고, 필요한 이미지 한 장 또는 여러 장만 처리합니다.</p>
        </div>
        {files.length > 0 && !result && (
          <button className="quiet-button" type="button" disabled={isEnhancing} onClick={onClear}>전체 비우기</button>
        )}
      </div>

      {error && <div className="error-message upscale-error" role="alert">{error}</div>}

      {result ? (
        <div className="upscale-complete-state">
          <span className="complete-icon">✓</span>
          <h2>업스케일이 완료되었습니다</h2>
          <p>{result.processedCount}장을 {result.targetWidth}×{result.targetHeight} JPEG로 저장했습니다. 원본은 그대로 보존했습니다.</p>
          <div className="output-path" title={result.outputDir}>{result.outputDir}</div>
          <div className="complete-actions">
            <button type="button" onClick={onChoose}>다른 이미지 선택</button>
            <button className="secondary-button" type="button" onClick={onClear}>새로 시작</button>
          </div>
        </div>
      ) : (
        <>
          <div className={`upscale-drop-zone ${files.length > 0 ? "has-files" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <span className="upscale-drop-icon">↥</span>
            <h3>이미지를 여기에 드롭하세요</h3>
            <p>한 장 또는 여러 장의 PNG, JPG, JPEG 파일을 동시에 올릴 수 있습니다.</p>
            <button className="primary-button" type="button" disabled={isEnhancing} onClick={onChoose}>파일 선택</button>
          </div>

          {isLoading && <div className="upscale-loading">이미지 미리보기를 준비하고 있습니다…</div>}

          {files.length > 0 && (
            <div className="upscale-file-panel">
              <div className="upscale-file-heading">
                <div>
                  <strong>{files.length}장 선택됨</strong>
                  <span>첫 번째 이미지가 있는 폴더의 새 출력 폴더에 저장됩니다.</span>
                </div>
                <span className="upscale-target-label">2560×1440 · JPEG 94</span>
              </div>
              <div className="upscale-file-grid">
                {files.map((file) => (
                  <article className="upscale-file-card" key={file.path}>
                    <img src={previews[file.path] ?? file.source} alt={file.fileName} />
                    <button className="upscale-remove" type="button" disabled={isEnhancing} aria-label={`${file.fileName} 제거`} onClick={() => onRemove(file.path)}>×</button>
                    <span title={file.fileName}>{file.fileName}</span>
                  </article>
                ))}
              </div>
              {isEnhancing && progress ? (
                <div className="upscale-progress" aria-label={`업스케일 진행률 ${progress.percent}%`}>
                  <div className="upscale-progress-heading"><span>{progress.message}</span><strong>{progress.percent}%</strong></div>
                  <div className="progress-track"><div className="progress-value" style={{ width: `${progress.percent}%` }} /></div>
                </div>
              ) : (
                <button className="upscale-start-button" type="button" disabled={isLoading} onClick={onEnhance}>2560×1440 JPEG 자동 개선 시작</button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
