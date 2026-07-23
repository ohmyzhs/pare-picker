import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import ScriptSplitter from "./ScriptSplitter";

type ImageFile = {
  path: string;
  fileName: string;
};

type ImagePair = {
  id: string;
  left: ImageFile;
  right: ImageFile;
};

type ScanResult = {
  pairs: ImagePair[];
  skippedCount: number;
  readyToRenameCount: number;
};

type NormalizeResult = {
  renamedCount: number;
  skippedCount: number;
};

type Preview = {
  pairId: string;
  left: string;
  right: string;
};

type Tool = "image" | "script";

type ScriptDrop = {
  id: number;
  path: string;
};

const isUsablePath = (value: string) => value.trim().length > 0;

function filePathFromDrop(value: string) {
  const firstValue = value.split(/\r?\n/).find(Boolean)?.trim() ?? "";
  if (!firstValue) return "";

  if (firstValue.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(firstValue).pathname);
    } catch {
      return "";
    }
  }

  return firstValue;
}

export default function App() {
  const [activeTool, setActiveTool] = useState<Tool>("image");
  const [scriptDroppedFile, setScriptDroppedFile] = useState<ScriptDrop | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [pairs, setPairs] = useState<ImagePair[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [readyToRenameCount, setReadyToRenameCount] = useState(0);
  const [legacyRenamedCount, setLegacyRenamedCount] = useState<number | null>(null);
  const [pairIndex, setPairIndex] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState("");

  const activePair = pairs[pairIndex];
  const progress = pairs.length === 0 ? 0 : (pairIndex / pairs.length) * 100;
  const isFinished = pairs.length > 0 && pairIndex >= pairs.length;

  const loadFolder = useCallback(async (path: string) => {
    if (!isUsablePath(path)) return;

    setIsLoading(true);
    setError("");
    setPreview(null);

    try {
      const result = await invoke<ScanResult>("scan_image_pairs", { folderPath: path.trim() });
      setFolderPath(path.trim());
      setPairs(result.pairs);
      setSkippedCount(result.skippedCount);
      setReadyToRenameCount(result.readyToRenameCount);
      setLegacyRenamedCount(null);
      setPairIndex(0);
      setCompletedCount(0);

      if (result.pairs.length === 0) {
        setError("완전한 -1/-2 또는 -01/-02 이미지 쌍을 찾지 못했습니다.");
      }
    } catch (reason) {
      setPairs([]);
      setReadyToRenameCount(0);
      setLegacyRenamedCount(null);
      setPairIndex(0);
      setCompletedCount(0);
      setError(String(reason));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const chooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "이미지 쌍이 있는 폴더 선택",
    });

    if (typeof selected === "string") {
      await loadFolder(selected);
    }
  }, [loadFolder]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths[0]) {
          if (activeTool === "image") {
            void loadFolder(event.payload.paths[0]);
          } else {
            setScriptDroppedFile({ id: Date.now(), path: event.payload.paths[0] });
          }
        }
      })
      .then((listener) => {
        unlisten = listener;
      });

    return () => unlisten?.();
  }, [activeTool, loadFolder]);

  useEffect(() => {
    if (!activePair) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setPreview(null);
    setError("");

    void Promise.all([
      invoke<string>("load_image_data_url", { path: activePair.left.path }),
      invoke<string>("load_image_data_url", { path: activePair.right.path }),
    ])
      .then(([left, right]) => {
        if (!cancelled) setPreview({ pairId: activePair.id, left, right });
      })
      .catch((reason) => {
        if (!cancelled) setError(`이미지를 불러오지 못했습니다: ${String(reason)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [activePair]);

  const selectImage = useCallback(
    async (keep: "left" | "right") => {
      if (!activePair || isDeleting || !preview) return;

      setIsDeleting(true);
      setError("");
      const kept = keep === "left" ? activePair.left : activePair.right;
      const rejected = keep === "left" ? activePair.right : activePair.left;

      try {
        await invoke("finalize_selection", {
          keepPath: kept.path,
          discardPath: rejected.path,
        });
        setCompletedCount((count) => count + 1);
        setPairIndex((index) => index + 1);
      } catch (reason) {
        setError(`선택을 정리하지 못했습니다: ${String(reason)}`);
      } finally {
        setIsDeleting(false);
      }
    },
    [activePair, isDeleting, preview],
  );

  const normalizeRemainingImages = useCallback(async () => {
    if (!folderPath || isDeleting || readyToRenameCount === 0) return;

    setIsDeleting(true);
    setError("");
    try {
      const result = await invoke<NormalizeResult>("normalize_remaining_images", { folderPath });
      setReadyToRenameCount(0);
      setSkippedCount((count) => Math.max(0, count - result.renamedCount));
      setLegacyRenamedCount(result.renamedCount);
    } catch (reason) {
      setError(`파일명을 정리하지 못했습니다: ${String(reason)}`);
    } finally {
      setIsDeleting(false);
    }
  }, [folderPath, isDeleting, readyToRenameCount]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeTool !== "image") return;
      if (event.key === "1" || event.key === "ArrowLeft") void selectImage("left");
      if (event.key === "2" || event.key === "ArrowRight") void selectImage("right");
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTool, selectImage]);

  const statusMessage = useMemo(() => {
    if (isLoading) return "폴더에서 이미지 쌍을 찾고 있습니다…";
    if (isDeleting) return "선택 결과를 정리하고 있습니다…";
    if (legacyRenamedCount !== null) return `${legacyRenamedCount}장의 파일명을 정리했습니다.`;
    if (isFinished) return "모든 이미지 쌍을 정리했습니다.";
    if (activePair) return `${pairIndex + 1} / ${pairs.length} 쌍`;
    return "폴더를 선택하거나 여기로 드래그하세요.";
  }, [activePair, isDeleting, isFinished, isLoading, pairIndex, pairs.length]);

  const acceptTextDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    const droppedPath = filePathFromDrop(
      event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"),
    );
    if (!droppedPath) return;
    if (activeTool === "image") {
      void loadFolder(droppedPath);
    } else {
      setScriptDroppedFile({ id: Date.now(), path: droppedPath });
    }
  };

  return (
    <main className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={acceptTextDrop}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PP</span>
          <div>
            <h1>Pair Picker</h1>
            <p>{activeTool === "image" ? "둘 중 남길 한 장을 선택하세요" : "대본을 단락 단위로 나눕니다"}</p>
          </div>
        </div>
        <nav className="tool-tabs" aria-label="도구 선택">
          <button className={activeTool === "image" ? "active" : ""} type="button" onClick={() => setActiveTool("image")}>사진 선택</button>
          <button className={activeTool === "script" ? "active" : ""} type="button" onClick={() => setActiveTool("script")}>대본 분할</button>
        </nav>
        {activeTool === "image" && <div className="path-picker">
          <input
            aria-label="이미지 폴더 경로"
            value={folderPath}
            placeholder="이미지 폴더 경로를 붙여넣거나 드래그"
            onChange={(event) => setFolderPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void loadFolder(folderPath);
            }}
          />
          <button type="button" onClick={() => void loadFolder(folderPath)} disabled={!isUsablePath(folderPath) || isLoading}>
            열기
          </button>
          <button className="folder-button" type="button" onClick={() => void chooseFolder()}>
            폴더 선택
          </button>
        </div>}
      </header>

      {activeTool === "image" ? <>
      <section className="status-row" aria-live="polite">
        <div className="status-copy">
          <span className={`status-dot ${isDeleting || isLoading ? "working" : ""}`} />
          <span>{statusMessage}</span>
          {skippedCount > 0 && <small>쌍이 아닌 이미지 또는 완전하지 않은 쌍 {skippedCount}개는 건드리지 않습니다.</small>}
        </div>
        {pairs.length > 0 && (
          <div className="progress-wrap" aria-label={`진행률 ${Math.round(progress)}%`}>
            <span>{completedCount}장 선택 · {pairs.length - pairIndex}쌍 남음</span>
            <div className="progress-track"><div className="progress-value" style={{ width: `${progress}%` }} /></div>
          </div>
        )}
      </section>

      {error && <div className="error-message" role="alert">{error}</div>}

      <section className="pair-stage" aria-busy={isDeleting || isLoading}>
        {isFinished ? (
          <div className="complete-state">
            <span className="complete-icon">✓</span>
            <h2>정리가 완료되었습니다</h2>
            <p>{completedCount}쌍에서 선택한 {completedCount}장을 남기고, 나머지는 휴지통으로 옮겼습니다.</p>
            <button type="button" onClick={() => void chooseFolder()}>다른 폴더 선택</button>
          </div>
        ) : activePair ? (
          <>
            <ImageCanvas
              image={activePair.left}
              source={preview?.pairId === activePair.id ? preview.left : undefined}
              side="1"
              disabled={isDeleting || !preview}
              onSelect={() => void selectImage("left")}
            />
            <div className="stage-divider"><span>KEEP</span></div>
            <ImageCanvas
              image={activePair.right}
              source={preview?.pairId === activePair.id ? preview.right : undefined}
              side="2"
              disabled={isDeleting || !preview}
              onSelect={() => void selectImage("right")}
            />
          </>
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
            <p>{legacyRenamedCount}장을 <code>001.jpeg</code>처럼 숫자 파일명으로 바꿨습니다.</p>
            <button type="button" onClick={() => void chooseFolder()}>다른 폴더 선택</button>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">↙</span>
            <h2>이미지 폴더를 놓아주세요</h2>
            <p><code>-1 / -2</code> 또는 <code>-01 / -02</code>로 끝나는 PNG, JPG, JPEG 파일을 자동으로 쌍으로 묶습니다.</p>
            <button type="button" onClick={() => void chooseFolder()}>폴더 선택</button>
          </div>
        )}
      </section>

      <footer>
        <span>클릭한 이미지는 <code>001.jpeg</code>처럼 이름을 정리하고, 반대쪽 이미지는 휴지통으로 이동합니다.</span>
        <span>단축키: <kbd>1</kbd>/<kbd>←</kbd> 왼쪽 · <kbd>2</kbd>/<kbd>→</kbd> 오른쪽</span>
      </footer>
      </> : <ScriptSplitter
        droppedFile={scriptDroppedFile}
        onDropConsumed={() => setScriptDroppedFile(null)}
      />}
    </main>
  );
}

type ImageCanvasProps = {
  image: ImageFile;
  source?: string;
  side: "1" | "2";
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
