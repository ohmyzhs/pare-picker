use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, RgbImage};
use serde::Serialize;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

const TARGET_WIDTH: u32 = 2560;
const TARGET_HEIGHT: u32 = 1440;
const JPEG_QUALITY: u8 = 94;
const MODEL_NAME: &str = "realesr-animevideov3";
const MODEL_FILE_STEM: &str = "realesr-animevideov3-x2";
const OUTPUT_FOLDER_NAME: &str = "업스케일_2560x1440";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnhanceResult {
    processed_count: usize,
    output_dir: String,
    target_width: u32,
    target_height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnhanceProgress {
    stage: &'static str,
    current: usize,
    total: usize,
    percent: u8,
    message: String,
}

struct WorkDirectory(PathBuf);

struct EnhancementInput {
    source: PathBuf,
    output_stem: String,
}

impl Drop for WorkDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) async fn enhance_selected_folder(
    app: AppHandle,
    folder: PathBuf,
) -> Result<EnhanceResult, String> {
    if !folder.is_dir() {
        return Err("선택한 경로가 폴더가 아닙니다.".into());
    }

    let inputs = collect_numbered_images(&folder)?;
    if inputs.is_empty() {
        return Err("001.jpeg처럼 숫자 이름으로 선택 완료된 이미지를 찾지 못했습니다.".into());
    }

    let inputs = inputs
        .into_iter()
        .map(|source| {
            let output_stem = source
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or_else(|| format!("{} 파일명을 읽지 못했습니다.", source.display()))?
                .to_owned();
            Ok(EnhancementInput {
                source,
                output_stem,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    enhance_inputs(&app, &folder, inputs).await
}

pub(crate) async fn enhance_selected_files(
    app: AppHandle,
    files: Vec<PathBuf>,
) -> Result<EnhanceResult, String> {
    let mut seen_stems = BTreeMap::new();
    let mut inputs = Vec::new();

    for source in files {
        if !source.is_file() || !super::is_image_path(&source) {
            return Err(format!(
                "업스케일할 이미지 파일이 아닙니다: {}",
                source.display()
            ));
        }

        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("{} 파일명을 읽지 못했습니다.", source.display()))?;
        let occurrence = seen_stems.entry(stem.to_owned()).or_insert(0usize);
        *occurrence += 1;
        let output_stem = if *occurrence == 1 {
            stem.to_owned()
        } else {
            format!("{stem}_{}", occurrence)
        };
        inputs.push(EnhancementInput {
            source,
            output_stem,
        });
    }

    if inputs.is_empty() {
        return Err("업스케일할 이미지 파일을 하나 이상 드롭해 주세요.".into());
    }

    let output_parent = inputs
        .first()
        .and_then(|input| input.source.parent())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    enhance_inputs(&app, &output_parent, inputs).await
}

async fn enhance_inputs(
    app: &AppHandle,
    folder: &Path,
    inputs: Vec<EnhancementInput>,
) -> Result<EnhanceResult, String> {
    if !folder.is_dir() {
        return Err("출력 폴더를 찾지 못했습니다.".into());
    }

    let total = inputs.len();
    emit_progress(
        app,
        "preparing",
        0,
        total,
        2,
        format!("선택 완료 이미지 {total}장을 준비하고 있습니다…"),
    );

    let work = WorkDirectory(create_work_directory(folder)?);
    let staged_input = work.0.join("input");
    let ai_output = work.0.join("ai-output");
    let final_output = work.0.join("final-output");
    fs::create_dir_all(&staged_input)
        .and_then(|_| fs::create_dir_all(&ai_output))
        .and_then(|_| fs::create_dir_all(&final_output))
        .map_err(|error| format!("업스케일 작업 폴더를 만들지 못했습니다: {error}"))?;

    let mut ai_inputs = Vec::new();
    let mut prepared_inputs = Vec::new();
    for (index, input) in inputs.into_iter().enumerate() {
        let (width, height) = image::image_dimensions(&input.source).map_err(|error| {
            format!("{} 크기를 읽지 못했습니다: {error}", input.source.display())
        })?;
        if width < TARGET_WIDTH || height < TARGET_HEIGHT {
            let extension = input
                .source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("jpeg");
            let stage_stem = format!("{index:04}-{}", input.output_stem);
            let staged_path = staged_input.join(format!("{stage_stem}.{extension}"));
            fs::copy(&input.source, &staged_path).map_err(|error| {
                format!("{} 복사에 실패했습니다: {error}", input.source.display())
            })?;
            ai_inputs.push(stage_stem.clone());
            prepared_inputs.push((input, Some(stage_stem)));
        } else {
            prepared_inputs.push((input, None));
        }
    }

    if !ai_inputs.is_empty() {
        run_realesrgan(app, &staged_input, &ai_output, ai_inputs.len(), total).await?;
    }

    let ai_count = ai_inputs.len();
    let mut completed = 0usize;
    for (input, ai_stem) in prepared_inputs {
        let source = if let Some(ai_stem) = ai_stem {
            ai_output.join(format!("{ai_stem}.png"))
        } else {
            input.source.clone()
        };
        if !source.is_file() {
            return Err(format!(
                "Real-ESRGAN 결과 파일을 찾지 못했습니다: {}",
                source.display()
            ));
        }

        let destination = final_output.join(format!("{}.jpg", input.output_stem));
        enhance_and_save(&source, &destination)?;
        completed += 1;
        let percent = if ai_count > 0 {
            72 + ((completed * 27) / total) as u8
        } else {
            10 + ((completed * 89) / total) as u8
        };
        emit_progress(
            app,
            "finishing",
            completed,
            total,
            percent.min(99),
            format!("색감과 선명도를 보정하고 있습니다 · {completed}/{total}"),
        );
    }

    let output_dir = next_output_directory(folder);
    fs::rename(&final_output, &output_dir)
        .map_err(|error| format!("완성 폴더를 저장하지 못했습니다: {error}"))?;

    emit_progress(
        app,
        "done",
        total,
        total,
        100,
        format!("{total}장 자동 개선을 완료했습니다."),
    );

    Ok(EnhanceResult {
        processed_count: total,
        output_dir: output_dir.to_string_lossy().into_owned(),
        target_width: TARGET_WIDTH,
        target_height: TARGET_HEIGHT,
    })
}

async fn run_realesrgan(
    app: &AppHandle,
    input_dir: &Path,
    output_dir: &Path,
    ai_count: usize,
    total: usize,
) -> Result<(), String> {
    let model_dir = app
        .path()
        .resolve("models", BaseDirectory::Resource)
        .map_err(|error| format!("Real-ESRGAN 모델 경로를 찾지 못했습니다: {error}"))?;
    let model_bin = model_dir.join(format!("{MODEL_FILE_STEM}.bin"));
    let model_param = model_dir.join(format!("{MODEL_FILE_STEM}.param"));
    if !model_bin.is_file() || !model_param.is_file() {
        return Err(format!(
            "Real-ESRGAN 애니메이션 2x 모델이 없습니다: {}",
            model_dir.display()
        ));
    }

    emit_progress(
        app,
        "upscaling",
        0,
        total,
        10,
        format!("Real-ESRGAN으로 {ai_count}장을 2배 업스케일하고 있습니다…"),
    );

    let command = app
        .shell()
        .sidecar("realesrgan-ncnn-vulkan")
        .map_err(|error| format!("Real-ESRGAN 실행 파일을 열지 못했습니다: {error}"))?
        .args([
            "-i",
            input_dir.to_string_lossy().as_ref(),
            "-o",
            output_dir.to_string_lossy().as_ref(),
            "-n",
            MODEL_NAME,
            "-s",
            "2",
            "-m",
            model_dir.to_string_lossy().as_ref(),
            "-f",
            "png",
        ]);
    let output = command
        .output()
        .await
        .map_err(|error| format!("Real-ESRGAN 실행에 실패했습니다: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = [stderr.as_ref(), stdout.as_ref()]
            .into_iter()
            .flat_map(str::lines)
            .filter(|line| !line.trim().is_empty())
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" / ");
        return Err(if detail.is_empty() {
            "Real-ESRGAN이 비정상 종료되었습니다. Vulkan/Metal 또는 그래픽 드라이버를 확인하세요."
                .into()
        } else {
            format!("Real-ESRGAN이 비정상 종료되었습니다: {detail}")
        });
    }

    emit_progress(
        app,
        "upscaling",
        ai_count,
        total,
        72,
        "AI 업스케일을 완료했습니다. 자동 보정을 적용합니다…".into(),
    );
    Ok(())
}

pub(crate) fn enhance_and_save(source: &Path, destination: &Path) -> Result<(), String> {
    enhance_and_save_to_size(source, destination, TARGET_WIDTH, TARGET_HEIGHT)
}

pub(crate) fn enhance_and_save_to_size(
    source: &Path,
    destination: &Path,
    target_width: u32,
    target_height: u32,
) -> Result<(), String> {
    if target_width == 0 || target_height == 0 {
        return Err("출력 해상도는 1픽셀 이상이어야 합니다.".into());
    }
    let image = image::open(source)
        .map_err(|error| format!("{} 이미지를 열지 못했습니다: {error}", source.display()))?;
    let resized = image
        .resize_to_fill(target_width, target_height, FilterType::Lanczos3)
        .to_rgb8();
    let enhanced = apply_gentle_auto_enhance(resized);
    let sharpened = DynamicImage::ImageRgb8(enhanced)
        .unsharpen(0.65, 2)
        .to_rgb8();
    let file = fs::File::create(destination)
        .map_err(|error| format!("{} 저장에 실패했습니다: {error}", destination.display()))?;
    let mut encoder = JpegEncoder::new_with_quality(file, JPEG_QUALITY);
    encoder
        .encode_image(&DynamicImage::ImageRgb8(sharpened))
        .map_err(|error| format!("{} 저장에 실패했습니다: {error}", destination.display()))
}

fn apply_gentle_auto_enhance(mut image: RgbImage) -> RgbImage {
    let mut histogram = [0usize; 256];
    let mut saturation_sum = 0.0f32;
    for pixel in image.pixels() {
        let red = pixel[0] as f32 / 255.0;
        let green = pixel[1] as f32 / 255.0;
        let blue = pixel[2] as f32 / 255.0;
        let luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        histogram[(luma * 255.0).round().clamp(0.0, 255.0) as usize] += 1;
        saturation_sum += red.max(green).max(blue) - red.min(green).min(blue);
    }

    let pixel_count = image.width() as usize * image.height() as usize;
    let median = percentile_from_histogram(&histogram, pixel_count, 0.5) as f32 / 255.0;
    let highlight = percentile_from_histogram(&histogram, pixel_count, 0.995) as f32 / 255.0;
    let average_saturation = saturation_sum / pixel_count.max(1) as f32;
    let gamma = if median < 0.32 {
        0.95
    } else if median < 0.43 {
        0.98
    } else {
        1.0
    };
    let shadow_lift = if median < 0.32 { 0.022 } else { 0.012 };
    let saturation = if average_saturation > 0.34 {
        1.015
    } else {
        1.04
    };
    let highlight_compression = if highlight > 0.98 { 0.94 } else { 0.97 };

    for pixel in image.pixels_mut() {
        let channels = [
            pixel[0] as f32 / 255.0,
            pixel[1] as f32 / 255.0,
            pixel[2] as f32 / 255.0,
        ];
        let luma = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        let mut tone = luma.powf(gamma);
        tone += shadow_lift * (1.0 - tone).powi(2);
        tone = 0.5 + (tone - 0.5) * 1.035;
        if tone > 0.86 {
            tone = 0.86 + (tone - 0.86) * highlight_compression;
        }

        for (index, channel) in channels.into_iter().enumerate() {
            let adjusted = tone + (channel - luma) * saturation;
            pixel[index] = (adjusted.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }

    image
}

fn percentile_from_histogram(histogram: &[usize; 256], total: usize, percentile: f32) -> usize {
    let target = ((total.saturating_sub(1)) as f32 * percentile).round() as usize;
    let mut cumulative = 0usize;
    for (value, count) in histogram.iter().enumerate() {
        cumulative += count;
        if cumulative > target {
            return value;
        }
    }
    255
}

pub(crate) fn collect_numbered_images(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let mut images = Vec::new();
    for entry in fs::read_dir(folder).map_err(|error| format!("폴더를 읽지 못했습니다: {error}"))?
    {
        let entry = entry.map_err(|error| format!("폴더 항목을 읽지 못했습니다: {error}"))?;
        let path = entry.path();
        if !path.is_file() || !super::is_image_path(&path) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !stem.is_empty() && stem.chars().all(|character| character.is_ascii_digit()) {
            images.push(path);
        }
    }

    images.sort_by(|left, right| {
        let left_stem = left
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let right_stem = right
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        left_stem
            .parse::<u64>()
            .unwrap_or(u64::MAX)
            .cmp(&right_stem.parse::<u64>().unwrap_or(u64::MAX))
            .then_with(|| left_stem.cmp(right_stem))
    });

    for pair in images.windows(2) {
        let left = pair[0].file_stem().and_then(|value| value.to_str());
        let right = pair[1].file_stem().and_then(|value| value.to_str());
        if left == right {
            return Err(format!(
                "같은 번호의 최종 이미지가 여러 개 있습니다: {}",
                left.unwrap_or_default()
            ));
        }
    }

    Ok(images)
}

fn create_work_directory(folder: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("작업 시간을 만들지 못했습니다: {error}"))?
        .as_millis();
    let work = folder.join(format!(
        ".pair-picker-upscale-{}-{timestamp}",
        std::process::id()
    ));
    fs::create_dir(&work)
        .map_err(|error| format!("임시 작업 폴더를 만들지 못했습니다: {error}"))?;
    Ok(work)
}

fn next_output_directory(folder: &Path) -> PathBuf {
    let base = folder.join(OUTPUT_FOLDER_NAME);
    if !base.exists() {
        return base;
    }
    for suffix in 2..=9999 {
        let candidate = folder.join(format!("{OUTPUT_FOLDER_NAME}_{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    folder.join(format!("{OUTPUT_FOLDER_NAME}_{}", std::process::id()))
}

fn emit_progress(
    app: &AppHandle,
    stage: &'static str,
    current: usize,
    total: usize,
    percent: u8,
    message: String,
) {
    let _ = app.emit(
        "enhance-progress",
        EnhanceProgress {
            stage,
            current,
            total,
            percent,
            message,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::{
        collect_numbered_images, enhance_and_save, enhance_and_save_to_size, next_output_directory,
    };

    #[test]
    fn collects_only_numbered_final_images_in_numeric_order() {
        let folder = std::env::temp_dir().join(format!(
            "pair-picker-enhance-collect-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        for name in ["010.jpeg", "002.png", "001.jpg", "003-01.jpeg", "cover.png"] {
            std::fs::write(folder.join(name), []).unwrap();
        }

        let names = collect_numbered_images(&folder)
            .unwrap()
            .into_iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["001.jpg", "002.png", "010.jpeg"]);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn enhancement_outputs_target_jpeg_without_touching_source() {
        let folder =
            std::env::temp_dir().join(format!("pair-picker-enhance-image-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let source = folder.join("source.png");
        let destination = folder.join("result.jpg");
        image::RgbImage::from_pixel(320, 180, image::Rgb([90, 120, 150]))
            .save(&source)
            .unwrap();

        enhance_and_save(&source, &destination).unwrap();

        assert_eq!(image::image_dimensions(&destination).unwrap(), (2560, 1440));
        assert_eq!(image::image_dimensions(&source).unwrap(), (320, 180));
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn enhancement_can_render_a_custom_comparison_size() {
        let folder = std::env::temp_dir().join(format!(
            "pair-picker-enhance-custom-size-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let source = folder.join("source.png");
        let destination = folder.join("result.jpg");
        image::RgbImage::from_pixel(320, 180, image::Rgb([90, 120, 150]))
            .save(&source)
            .unwrap();

        enhance_and_save_to_size(&source, &destination, 2560, 1440).unwrap();

        assert_eq!(image::image_dimensions(&destination).unwrap(), (2560, 1440));
        assert_eq!(image::image_dimensions(&source).unwrap(), (320, 180));
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn chooses_a_new_output_folder_instead_of_overwriting() {
        let folder =
            std::env::temp_dir().join(format!("pair-picker-enhance-output-{}", std::process::id()));
        std::fs::create_dir_all(folder.join("업스케일_2560x1440")).unwrap();

        assert_eq!(
            next_output_directory(&folder),
            folder.join("업스케일_2560x1440_2")
        );
        std::fs::remove_dir_all(folder).unwrap();
    }
}
