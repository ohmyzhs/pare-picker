use std::{env, fs, path::PathBuf};

fn main() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let output_dir = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("사용법: postprocess_samples_1440 <출력 폴더> <AI 업스케일 이미지...>")?;
    let inputs = arguments.map(PathBuf::from).collect::<Vec<_>>();
    if inputs.is_empty() {
        return Err("후처리할 AI 업스케일 이미지가 없습니다.".into());
    }
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("출력 폴더를 만들지 못했습니다: {error}"))?;

    for input in inputs {
        let stem = input
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("{} 파일명을 읽지 못했습니다.", input.display()))?;
        let output = output_dir.join(format!("{stem}.jpg"));
        pair_picker_lib::postprocess_upscaled_image_to_size(&input, &output, 2560, 1440)?;
        println!("{}", output.display());
    }

    Ok(())
}
