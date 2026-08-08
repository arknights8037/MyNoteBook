use std::{process::Command, time::Duration};

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    address: String,
    credential: String,
}

#[test]
fn headless_core_process_runs_without_tauri_and_accepts_authenticated_shutdown() {
    let directory = std::env::temp_dir().join(format!(
        "my-notebook-core-process-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    std::fs::create_dir_all(&directory).expect("create endpoint directory");
    let mut child = Command::new(env!("CARGO_BIN_EXE_my-notebook"))
        .arg("--mynotebook-headless-core")
        .arg("--endpoint-directory")
        .arg(&directory)
        .spawn()
        .expect("spawn Headless Core process");
    let endpoint_path = directory.join("endpoint-v1.json");
    let endpoint = loop {
        if let Ok(content) = std::fs::read_to_string(&endpoint_path) {
            if let Ok(endpoint) = serde_json::from_str::<Endpoint>(&content) {
                break endpoint;
            }
        }
        assert!(child.try_wait().expect("read child status").is_none());
        std::thread::sleep(Duration::from_millis(25));
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime");
    runtime.block_on(async {
        let response = reqwest::Client::new()
            .post(format!("http://{}/v1/shutdown", endpoint.address))
            .bearer_auth(endpoint.credential)
            .send()
            .await
            .expect("authenticated shutdown");
        assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    });
    for _ in 0..100 {
        if child.try_wait().expect("read child status").is_some() {
            assert!(!endpoint_path.exists());
            let _ = std::fs::remove_dir_all(directory);
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    panic!("Headless Core did not stop after authenticated shutdown");
}
