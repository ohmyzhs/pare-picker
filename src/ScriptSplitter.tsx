import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const MAX_CHARACTERS = 10_000;

type ScriptSplitResult = {
  chunks: string[];
  totalCharacters: number;
};

type ScriptDrop = {
  id: number;
  path: string;
};

type ScriptSplitterProps = {
  droppedFile: ScriptDrop | null;
  onDropConsumed: () => void;
};

const countCharacters = (value: string) => Array.from(value).length;

const filenameFromPath = (path: string) => path.split(/[\\/]/).at(-1) || "선택한 대본";

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

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.append(temporary);
  temporary.select();
  document.execCommand("copy");
  temporary.remove();
}

export default function ScriptSplitter({ droppedFile, onDropConsumed }: ScriptSplitterProps) {
  const [fileName, setFileName] = useState("");
  const [originalText, setOriginalText] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [chunks, setChunks] = useState<string[]>([]);
  const [totalCharacters, setTotalCharacters] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const splitText = useCallback(async (text: string) => {
    const result = await invoke<ScriptSplitResult>("split_script_text", { content: text });
    setChunks(result.chunks);
    setTotalCharacters(result.totalCharacters);
  }, []);

  const loadTextFile = useCallback(async (path: string) => {
    if (!path) return;

    setIsLoading(true);
    setError("");
    try {
      const content = await invoke<string>("read_text_file", { path });
      await splitText(content);
      setFileName(filenameFromPath(path));
      setOriginalText(content);
      setSourceText(content);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setIsLoading(false);
    }
  }, [splitText]);

  const chooseTextFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      title: "분할할 대본 TXT 파일 선택",
      filters: [{ name: "텍스트 파일", extensions: ["txt"] }],
    });

    if (typeof selected === "string") await loadTextFile(selected);
  }, [loadTextFile]);

  useEffect(() => {
    if (!droppedFile) return;
    void loadTextFile(droppedFile.path);
    onDropConsumed();
  }, [droppedFile, loadTextFile, onDropConsumed]);

  const resetToOriginal = useCallback(async () => {
    if (!originalText || isLoading) return;

    setIsLoading(true);
    setError("");
    try {
      await splitText(originalText);
      setSourceText(originalText);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, originalText, splitText]);

  const resplitSource = useCallback(async () => {
    if (!sourceText || isLoading) return;

    setIsLoading(true);
    setError("");
    try {
      await splitText(sourceText);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, sourceText, splitText]);

  const updateChunk = (index: number, value: string) => {
    setChunks((current) => current.map((chunk, chunkIndex) => (chunkIndex === index ? value : chunk)));
  };

  const copy = useCallback(async (key: string, value: string) => {
    try {
      await copyToClipboard(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1_800);
    } catch (reason) {
      setError(`클립보드에 복사하지 못했습니다: ${String(reason)}`);
    }
  }, []);

  const handleTextDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const droppedPath = filePathFromDrop(
      event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"),
    );
    if (droppedPath) void loadTextFile(droppedPath);
  };

  const chunkSummary = useMemo(() => {
    if (!chunks.length) return "TXT 파일을 선택하거나 이 화면으로 드래그하세요.";
    return `${chunks.length}개로 분할됨 · 각 상자는 10,000자 미만`;
  }, [chunks.length]);

  return (
    <section className="script-tool" onDragOver={(event) => event.preventDefault()} onDrop={handleTextDrop}>
      <div className="script-toolbar">
        <div>
          <span className="eyebrow">SCRIPT SPLITTER</span>
          <h2>대본 텍스트 분할기</h2>
          <p>{fileName ? `${fileName} · ${totalCharacters.toLocaleString()}자` : "빈 줄로 구분된 단락을 유지하며 분할합니다."}</p>
        </div>
        <div className="script-actions">
          {originalText && (
            <>
              <button className="quiet-button" type="button" disabled={isLoading} onClick={() => void resetToOriginal()}>원본으로 전체 리셋</button>
              <button className="quiet-button" type="button" disabled={isLoading} onClick={() => void resplitSource()}>다시 분리</button>
            </>
          )}
          <button className="primary-button" type="button" disabled={isLoading} onClick={() => void chooseTextFile()}>TXT 파일 선택</button>
        </div>
      </div>

      {error && <div className="error-message" role="alert">{error}</div>}

      {!originalText ? (
        <div className="script-empty-state">
          <span className="empty-icon">T</span>
          <h3>대본 TXT 파일을 놓아주세요</h3>
          <p>빈 줄로 구분한 단락을 절대 자르지 않고, 공백을 포함해 각 상자가 10,000자 미만이 되도록 나눕니다.</p>
          <button className="primary-button" type="button" onClick={() => void chooseTextFile()}>TXT 파일 선택</button>
        </div>
      ) : (
        <>
          <div className="script-status-row">
            <span className={`status-dot ${isLoading ? "working" : ""}`} />
            <span>{isLoading ? "대본을 분할하고 있습니다…" : chunkSummary}</span>
          </div>

          <details className="source-editor">
            <summary>원본 대본 편집 · {countCharacters(sourceText).toLocaleString()}자 <span>펼쳐서 편집 후 다시 분리</span></summary>
            <div className="text-card source-card">
              <div className="text-card-header">
                <strong>원본 대본</strong>
                <div><span>{countCharacters(sourceText).toLocaleString()}자</span><CopyButton copied={copiedKey === "source"} onClick={() => void copy("source", sourceText)} /></div>
              </div>
              <textarea aria-label="원본 대본" value={sourceText} onChange={(event) => setSourceText(event.target.value)} />
            </div>
          </details>

          <div className="split-results-heading">
            <div><span className="eyebrow">SPLIT PREVIEW</span><h3>분할된 대본</h3></div>
            <span>{chunks.length}개 텍스트 상자</span>
          </div>

          <div className="script-grid">
            {chunks.map((chunk, index) => (
              <article className="text-card" key={index}>
                <div className="text-card-header">
                  <strong>분할 {String(index + 1).padStart(2, "0")}</strong>
                  <div>
                    <span className={countCharacters(chunk) >= MAX_CHARACTERS ? "over-limit" : ""}>{countCharacters(chunk).toLocaleString()}자</span>
                    <CopyButton copied={copiedKey === `chunk-${index}`} onClick={() => void copy(`chunk-${index}`, chunk)} />
                  </div>
                </div>
                <textarea
                  aria-label={`분할 ${index + 1} 대본`}
                  value={chunk}
                  onChange={(event) => updateChunk(index, event.target.value)}
                />
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function CopyButton({ copied, onClick }: { copied: boolean; onClick: () => void }) {
  return <button className="copy-button" type="button" onClick={onClick}>{copied ? "복사됨" : "복사"}</button>;
}
