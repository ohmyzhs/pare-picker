use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

mod enhance;

const SCRIPT_CHUNK_LIMIT: usize = 10_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageFile {
    path: String,
    file_name: String,
}

#[derive(Debug, Clone, Serialize)]
struct ImageGroup {
    id: String,
    images: Vec<ImageFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    groups: Vec<ImageGroup>,
    skipped_count: usize,
    ready_to_rename_count: usize,
    ready_to_enhance_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NormalizeResult {
    renamed_count: usize,
    skipped_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptSplitResult {
    chunks: Vec<String>,
    total_characters: usize,
}

#[derive(Default)]
struct PairCandidates {
    images: BTreeMap<u8, ImageFile>,
    candidate_count: usize,
}

#[tauri::command]
fn scan_image_pairs(folder_path: String) -> Result<ScanResult, String> {
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err("선택한 경로가 폴더가 아닙니다.".into());
    }

    let mut candidates: BTreeMap<String, PairCandidates> = BTreeMap::new();
    let mut skipped_count = 0;
    let ready_to_rename_count = 0;
    let mut ready_to_enhance_count = 0;

    for entry in
        fs::read_dir(&folder).map_err(|error| format!("폴더를 읽지 못했습니다: {error}"))?
    {
        let entry = entry.map_err(|error| format!("폴더 항목을 읽지 못했습니다: {error}"))?;
        let path = entry.path();
        if !path.is_file() || !is_image_path(&path) {
            continue;
        }

        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            skipped_count += 1;
            continue;
        };
        if !stem.is_empty() && stem.chars().all(|character| character.is_ascii_digit()) {
            ready_to_enhance_count += 1;
            continue;
        }
        let Some((pair_id, side)) = split_pair_name(stem) else {
            skipped_count += 1;
            continue;
        };

        let image = image_file(&path);
        let group = candidates.entry(pair_id).or_default();
        group.candidate_count += 1;
        if let std::collections::btree_map::Entry::Vacant(entry) = group.images.entry(side) {
            entry.insert(image);
        } else {
            // A duplicate side is ambiguous. Leave it untouched instead of deleting the wrong file.
            skipped_count += 1;
        }
    }

    let mut groups = Vec::new();
    for (id, candidate) in candidates {
        let candidate_count = candidate.candidate_count;
        let image_count = candidate.images.len();
        if candidate_count != image_count || image_count > 8 {
            skipped_count += candidate_count;
        } else if image_count >= 2 {
            groups.push(ImageGroup {
                id,
                images: candidate.images.into_values().collect(),
            });
        } else if image_count == 1 {
            // A number with only one valid candidate is still actionable: show it
            // so the user can confirm it and normalize `013-01.jpeg` to `013.jpeg`.
            groups.push(ImageGroup {
                id,
                images: candidate.images.into_values().collect(),
            });
        }
    }

    Ok(ScanResult {
        groups,
        skipped_count,
        ready_to_rename_count,
        ready_to_enhance_count,
    })
}

#[tauri::command]
fn load_image_data_url(path: String) -> Result<String, String> {
    let image_path = PathBuf::from(path);
    if !image_path.is_file() || !is_image_path(&image_path) {
        return Err("지원하지 않는 이미지 파일입니다.".into());
    }

    let bytes =
        fs::read(&image_path).map_err(|error| format!("이미지를 읽지 못했습니다: {error}"))?;
    let mime_type = match image_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => return Err("지원하지 않는 이미지 형식입니다.".into()),
    };

    Ok(format!(
        "data:{mime_type};base64,{}",
        STANDARD.encode(bytes)
    ))
}

#[tauri::command]
fn finalize_selection(keep_path: String, discard_paths: Vec<String>) -> Result<(), String> {
    let keep_path = PathBuf::from(keep_path);
    let discard_paths: Vec<PathBuf> = discard_paths.into_iter().map(PathBuf::from).collect();
    let final_path = final_image_path(&keep_path, &discard_paths)?;

    fs::rename(&keep_path, &final_path)
        .map_err(|error| format!("선택한 이미지의 이름을 바꾸지 못했습니다: {error}"))?;

    for discard_path in discard_paths {
        if let Err(error) = trash::delete(&discard_path) {
            let rollback_result = fs::rename(&final_path, &keep_path);
            return match rollback_result {
                Ok(()) => Err(format!(
                    "선택하지 않은 이미지를 휴지통으로 옮기지 못했습니다: {error}"
                )),
                Err(rollback_error) => Err(format!(
                    "휴지통 이동에 실패했고 파일명 복구도 실패했습니다: {error}; {rollback_error}"
                )),
            };
        }
    }

    Ok(())
}

fn final_image_path(keep_path: &Path, discard_paths: &[PathBuf]) -> Result<PathBuf, String> {
    if !keep_path.is_file() || discard_paths.iter().any(|path| !path.is_file()) {
        return Err("선택할 이미지 파일을 찾지 못했습니다.".into());
    }
    if !is_image_path(keep_path) || discard_paths.iter().any(|path| !is_image_path(path)) {
        return Err("PNG, JPG, JPEG 파일만 선택할 수 있습니다.".into());
    }

    let keep_stem = keep_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("선택한 이미지의 파일명을 읽지 못했습니다.")?;
    let (pair_id, keep_side) =
        split_pair_name(keep_stem).ok_or("선택한 이미지가 올바른 쌍 파일명이 아닙니다.")?;
    let mut selected_sides = BTreeMap::new();
    selected_sides.insert(keep_side, keep_path);
    for discard_path in discard_paths {
        let discard_stem = discard_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or("선택하지 않은 이미지의 파일명을 읽지 못했습니다.")?;
        let (discard_id, discard_side) = split_pair_name(discard_stem)
            .ok_or("선택하지 않은 이미지의 파일명이 올바르지 않습니다.")?;

        if pair_id != discard_id || selected_sides.insert(discard_side, discard_path).is_some() {
            return Err("같은 번호의 후보 이미지에서 하나만 선택할 수 있습니다.".into());
        }
    }

    let extension = keep_path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("선택한 이미지의 확장자를 읽지 못했습니다.")?;
    let final_path = keep_path.with_file_name(format!("{pair_id}.{extension}"));
    let folder = keep_path.parent().ok_or("이미지 폴더를 찾지 못했습니다.")?;

    if numbered_image_exists(folder, &pair_id)? {
        return Err(format!(
            "이미 `{pair_id}` 이름의 이미지가 있어 덮어쓰지 않았습니다. 기존 파일을 확인한 뒤 다시 시도하세요."
        ));
    }

    Ok(final_path)
}

fn numbered_image_exists(folder: &Path, pair_id: &str) -> Result<bool, String> {
    for entry in fs::read_dir(folder).map_err(|error| format!("폴더를 읽지 못했습니다: {error}"))?
    {
        let entry = entry.map_err(|error| format!("폴더 항목을 읽지 못했습니다: {error}"))?;
        let path = entry.path();
        if path.is_file()
            && is_image_path(&path)
            && path.file_stem().and_then(|value| value.to_str()) == Some(pair_id)
        {
            return Ok(true);
        }
    }

    Ok(false)
}

#[tauri::command]
fn normalize_remaining_images(folder_path: String) -> Result<NormalizeResult, String> {
    let folder = PathBuf::from(folder_path);
    if !folder.is_dir() {
        return Err("선택한 경로가 폴더가 아닙니다.".into());
    }

    let mut candidates: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for entry in
        fs::read_dir(&folder).map_err(|error| format!("폴더를 읽지 못했습니다: {error}"))?
    {
        let entry = entry.map_err(|error| format!("폴더 항목을 읽지 못했습니다: {error}"))?;
        let path = entry.path();
        if !path.is_file() || !is_image_path(&path) {
            continue;
        }

        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if let Some((pair_id, _)) = split_pair_name(stem) {
            candidates.entry(pair_id).or_default().push(path);
        }
    }

    let mut planned_renames = Vec::new();
    let mut skipped_count = 0;
    for (pair_id, paths) in candidates {
        if paths.len() != 1 {
            skipped_count += paths.len();
            continue;
        }

        let source = paths.into_iter().next().expect("one image path exists");
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .ok_or("이미지 확장자를 읽지 못했습니다.")?
            .to_owned();
        if numbered_image_exists(&folder, &pair_id)? {
            return Err(format!(
                "이미 `{pair_id}` 이름의 이미지가 있어 어떤 파일도 바꾸지 않았습니다. 기존 파일을 확인한 뒤 다시 시도하세요."
            ));
        }

        planned_renames.push((source, folder.join(format!("{pair_id}.{extension}"))));
    }

    let mut renamed = Vec::new();
    for (source, destination) in &planned_renames {
        if let Err(error) = fs::rename(source, destination) {
            for (completed_source, completed_destination) in renamed.iter().rev() {
                let _ = fs::rename(completed_destination, completed_source);
            }
            return Err(format!("파일명을 정리하지 못했습니다: {error}"));
        }
        renamed.push((source.clone(), destination.clone()));
    }

    Ok(NormalizeResult {
        renamed_count: renamed.len(),
        skipped_count,
    })
}

#[tauri::command]
async fn enhance_selected_images(
    app: tauri::AppHandle,
    folder_path: String,
) -> Result<enhance::EnhanceResult, String> {
    enhance::enhance_selected_folder(app, PathBuf::from(folder_path)).await
}

#[tauri::command]
async fn enhance_selected_files(
    app: tauri::AppHandle,
    file_paths: Vec<String>,
) -> Result<enhance::EnhanceResult, String> {
    let files = file_paths.into_iter().map(PathBuf::from).collect();
    enhance::enhance_selected_files(app, files).await
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let text_path = PathBuf::from(path);
    if !text_path.is_file()
        || !matches!(
            text_path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.to_ascii_lowercase()),
            Some(extension) if extension == "txt"
        )
    {
        return Err("TXT 파일만 불러올 수 있습니다.".into());
    }

    let content = fs::read_to_string(&text_path)
        .map_err(|error| format!("텍스트 파일을 읽지 못했습니다: {error}"))?;
    Ok(content.trim_start_matches('\u{feff}').to_owned())
}

#[tauri::command]
fn split_script_text(content: String) -> Result<ScriptSplitResult, String> {
    let normalized = content
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let paragraphs = paragraphs_from_text(&normalized);

    let mut chunks = Vec::new();
    let mut current_chunk = String::new();

    for (index, paragraph) in paragraphs.iter().enumerate() {
        let paragraph_characters = character_count(paragraph);
        if paragraph_characters >= SCRIPT_CHUNK_LIMIT {
            return Err(format!(
                "{}번째 단락이 {paragraph_characters}자입니다. 단락 중간은 자르지 않으므로 10,000자 미만으로 직접 줄인 뒤 다시 분리하세요.",
                index + 1
            ));
        }

        let separator = if current_chunk.is_empty() { "" } else { "\n\n" };
        let candidate_characters =
            character_count(&current_chunk) + character_count(separator) + paragraph_characters;

        if !current_chunk.is_empty() && candidate_characters >= SCRIPT_CHUNK_LIMIT {
            chunks.push(current_chunk);
            current_chunk = paragraph.clone();
        } else {
            current_chunk.push_str(separator);
            current_chunk.push_str(paragraph);
        }
    }

    if !current_chunk.is_empty() {
        chunks.push(current_chunk);
    }

    Ok(ScriptSplitResult {
        chunks,
        total_characters: character_count(&normalized),
    })
}

fn paragraphs_from_text(content: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut current_lines = Vec::new();

    for line in content.lines() {
        if line.trim().is_empty() {
            if !current_lines.is_empty() {
                paragraphs.push(current_lines.join("\n"));
                current_lines.clear();
            }
        } else {
            current_lines.push(line);
        }
    }

    if !current_lines.is_empty() {
        paragraphs.push(current_lines.join("\n"));
    }

    paragraphs
}

fn character_count(content: &str) -> usize {
    content.chars().count()
}

fn image_file(path: &Path) -> ImageFile {
    ImageFile {
        path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase()),
        Some(extension) if matches!(extension.as_str(), "png" | "jpg" | "jpeg")
    )
}

fn split_pair_name(stem: &str) -> Option<(String, u8)> {
    let (prefix, suffix) = stem.rsplit_once('-')?;
    if prefix.is_empty() || suffix.is_empty() || suffix.len() > 2 {
        return None;
    }
    let side = suffix.parse::<u8>().ok()?;
    if (1..=8).contains(&side) {
        Some((prefix.to_owned(), side))
    } else {
        None
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            scan_image_pairs,
            load_image_data_url,
            finalize_selection,
            normalize_remaining_images,
            enhance_selected_images,
            enhance_selected_files,
            read_text_file,
            split_script_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pair Picker");
}

/// Applies the same 2560x1440 crop, gentle tone, saturation, sharpening, and JPEG pass
/// used after Real-ESRGAN.
pub fn postprocess_upscaled_image(source: &Path, destination: &Path) -> Result<(), String> {
    enhance::enhance_and_save(source, destination)
}

/// Applies the production enhancement pass at a caller-selected comparison size.
pub fn postprocess_upscaled_image_to_size(
    source: &Path,
    destination: &Path,
    width: u32,
    height: u32,
) -> Result<(), String> {
    enhance::enhance_and_save_to_size(source, destination, width, height)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        character_count, final_image_path, finalize_selection, scan_image_pairs, split_pair_name,
        split_script_text, SCRIPT_CHUNK_LIMIT,
    };

    #[test]
    fn recognizes_zero_padded_pair_names() {
        assert_eq!(split_pair_name("000-01"), Some(("000".into(), 1)));
        assert_eq!(split_pair_name("000-02"), Some(("000".into(), 2)));
        assert_eq!(split_pair_name("000-08"), Some(("000".into(), 8)));
    }

    #[test]
    fn recognizes_unpadded_pair_names() {
        assert_eq!(split_pair_name("001-1"), Some(("001".into(), 1)));
        assert_eq!(split_pair_name("001-2"), Some(("001".into(), 2)));
    }

    #[test]
    fn ignores_non_pair_names() {
        assert_eq!(split_pair_name("mandol"), None);
        assert_eq!(split_pair_name("001-09"), None);
        assert_eq!(split_pair_name("001-001"), None);
    }

    #[test]
    fn groups_up_to_eight_candidates_in_numeric_order() {
        let folder =
            std::env::temp_dir().join(format!("pair-picker-candidates-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        for side in 1..=8 {
            std::fs::write(folder.join(format!("001-{side:02}.jpeg")), []).unwrap();
        }

        let result = scan_image_pairs(folder.to_string_lossy().into_owned()).unwrap();

        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].images.len(), 8);
        assert_eq!(result.groups[0].images[0].file_name, "001-01.jpeg");
        assert_eq!(result.groups[0].images[7].file_name, "001-08.jpeg");

        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn keeps_a_single_candidate_visible_for_selection() {
        let folder = std::env::temp_dir().join(format!(
            "pair-picker-single-candidate-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("013-01.jpeg"), []).unwrap();

        let result = scan_image_pairs(folder.to_string_lossy().into_owned()).unwrap();

        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].id, "013");
        assert_eq!(result.groups[0].images.len(), 1);
        assert_eq!(result.groups[0].images[0].file_name, "013-01.jpeg");
        assert_eq!(result.ready_to_rename_count, 0);
        assert_eq!(result.skipped_count, 0);

        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn reports_numbered_images_as_ready_for_enhancement() {
        let folder =
            std::env::temp_dir().join(format!("pair-picker-ready-enhance-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("001.jpeg"), []).unwrap();
        std::fs::write(folder.join("002.png"), []).unwrap();
        std::fs::write(folder.join("cover.jpeg"), []).unwrap();

        let result = scan_image_pairs(folder.to_string_lossy().into_owned()).unwrap();

        assert_eq!(result.ready_to_enhance_count, 2);
        assert_eq!(result.skipped_count, 1);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn final_filename_removes_the_pair_suffix() {
        let folder = std::env::temp_dir().join(format!("pair-picker-test-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let keep = folder.join("001-01.jpeg");
        let discard = folder.join("001-02.jpeg");
        std::fs::write(&keep, []).unwrap();
        std::fs::write(&discard, []).unwrap();

        assert_eq!(
            final_image_path(&keep, &[discard]).unwrap(),
            Path::new(&folder).join("001.jpeg")
        );

        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn final_filename_supports_a_single_candidate_without_discard() {
        let folder = std::env::temp_dir().join(format!(
            "pair-picker-single-finalize-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let keep = folder.join("013-01.jpeg");
        std::fs::write(&keep, []).unwrap();

        assert_eq!(
            final_image_path(&keep, &[]).unwrap(),
            Path::new(&folder).join("013.jpeg")
        );
        finalize_selection(keep.to_string_lossy().into_owned(), vec![]).unwrap();
        assert!(folder.join("013.jpeg").is_file());
        assert!(!keep.exists());

        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn preserves_existing_numbered_image() {
        let folder =
            std::env::temp_dir().join(format!("pair-picker-collision-test-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let keep = folder.join("001-1.jpeg");
        let discard = folder.join("001-2.jpeg");
        std::fs::write(&keep, []).unwrap();
        std::fs::write(&discard, []).unwrap();
        std::fs::write(folder.join("001.png"), []).unwrap();

        assert!(final_image_path(&keep, &[discard]).is_err());

        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn normalizes_a_single_completed_choice() {
        let folder =
            std::env::temp_dir().join(format!("pair-picker-normalize-test-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("001-2.jpeg"), []).unwrap();

        let result =
            super::normalize_remaining_images(folder.to_string_lossy().into_owned()).unwrap();

        assert_eq!(result.renamed_count, 1);
        assert!(folder.join("001.jpeg").is_file());
        assert!(!folder.join("001-2.jpeg").exists());

        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn splits_before_a_paragraph_would_reach_ten_thousand_characters() {
        let first_paragraph = "가".repeat(9_840);
        let second_paragraph = "나".repeat(309);
        let result = split_script_text(format!("{first_paragraph}\n\n{second_paragraph}")).unwrap();

        assert_eq!(result.chunks.len(), 2);
        assert_eq!(character_count(&result.chunks[0]), 9_840);
        assert_eq!(character_count(&result.chunks[1]), 309);
    }

    #[test]
    fn rejects_a_single_paragraph_that_cannot_fit_without_cutting() {
        let result = split_script_text("가".repeat(SCRIPT_CHUNK_LIMIT));

        assert!(result.is_err());
    }
}
