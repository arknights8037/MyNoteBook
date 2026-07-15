use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, State};

const KEYRING_SERVICE: &str = "com.local.mynotebook";
const KEYRING_ACCOUNT: &str = "ai-secret-data-key";
const SECRET_FILENAME: &str = "ai-secrets.v1.json";
const SECRET_VERSION: u8 = 1;

#[derive(Default)]
pub struct AiSecretState {
    cached_api_keys: Mutex<Option<HashMap<String, String>>>,
    cached_data_key: Mutex<Option<[u8; 32]>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedSecret {
    version: u8,
    nonce: String,
    ciphertext: String,
}

#[tauri::command]
pub async fn get_ai_api_key(
    app: AppHandle,
    state: State<'_, AiSecretState>,
    provider: String,
) -> Result<String, String> {
    if let Some(api_keys) = state.cached_api_keys.lock().map_err(secret_error)?.as_ref() {
        return Ok(api_keys.get(&provider).cloned().unwrap_or_default());
    }

    let secret_path = secret_path(&app)?;
    if !secret_path.is_file() {
        return Ok(String::new());
    }
    let data_key = get_or_create_data_key(&state).await?;
    let plaintext =
        tauri::async_runtime::spawn_blocking(move || decrypt_secret(&secret_path, &data_key))
            .await
            .map_err(secret_error)??;
    let api_keys = decode_api_keys(&plaintext, &provider);
    let api_key = api_keys.get(&provider).cloned().unwrap_or_default();
    *state.cached_api_keys.lock().map_err(secret_error)? = Some(api_keys);
    Ok(api_key)
}

#[tauri::command]
pub async fn set_ai_api_key(
    app: AppHandle,
    state: State<'_, AiSecretState>,
    provider: String,
    api_key: String,
) -> Result<(), String> {
    let normalized = api_key.trim().to_string();
    let secret_path = secret_path(&app)?;
    let data_key = get_or_create_data_key(&state).await?;
    let mut api_keys = load_api_keys(&secret_path, &data_key, &state, &provider)?;
    if normalized.is_empty() {
        api_keys.remove(&provider);
    } else {
        api_keys.insert(provider, normalized);
    }
    if api_keys.is_empty() {
        if secret_path.exists() {
            fs::remove_file(secret_path).map_err(secret_error)?;
        }
        *state.cached_api_keys.lock().map_err(secret_error)? = Some(api_keys);
        return Ok(());
    }
    let value = serde_json::to_string(&api_keys).map_err(secret_error)?;
    tauri::async_runtime::spawn_blocking(move || encrypt_secret(&secret_path, &data_key, &value))
        .await
        .map_err(secret_error)??;
    *state.cached_api_keys.lock().map_err(secret_error)? = Some(api_keys);
    Ok(())
}

fn load_api_keys(
    path: &PathBuf,
    data_key: &[u8; 32],
    state: &AiSecretState,
    legacy_provider: &str,
) -> Result<HashMap<String, String>, String> {
    if let Some(api_keys) = state.cached_api_keys.lock().map_err(secret_error)?.clone() {
        return Ok(api_keys);
    }
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    decrypt_secret(path, data_key).map(|plaintext| decode_api_keys(&plaintext, legacy_provider))
}

fn decode_api_keys(plaintext: &str, legacy_provider: &str) -> HashMap<String, String> {
    serde_json::from_str(plaintext).unwrap_or_else(|_| {
        let mut api_keys = HashMap::new();
        if !plaintext.trim().is_empty() {
            api_keys.insert(legacy_provider.to_string(), plaintext.trim().to_string());
        }
        api_keys
    })
}

async fn get_or_create_data_key(state: &AiSecretState) -> Result<[u8; 32], String> {
    if let Some(key) = *state.cached_data_key.lock().map_err(secret_error)? {
        return Ok(key);
    }

    let key = tauri::async_runtime::spawn_blocking(load_or_create_keyring_key)
        .await
        .map_err(secret_error)??;
    *state.cached_data_key.lock().map_err(secret_error)? = Some(key);
    Ok(key)
}

fn load_or_create_keyring_key() -> Result<[u8; 32], String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(secret_error)?;
    match entry.get_password() {
        Ok(encoded) => decode_data_key(&encoded),
        Err(KeyringError::NoEntry) => {
            let key = Aes256Gcm::generate_key(&mut OsRng);
            entry
                .set_password(&general_purpose::STANDARD.encode(key))
                .map_err(secret_error)?;
            Ok(key.into())
        }
        Err(error) => Err(secret_error(error)),
    }
}

fn decode_data_key(encoded: &str) -> Result<[u8; 32], String> {
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(secret_error)?;
    bytes
        .try_into()
        .map_err(|_| "系统凭据库中的数据密钥长度无效。".to_string())
}

fn encrypt_secret(path: &PathBuf, data_key: &[u8; 32], api_key: &str) -> Result<(), String> {
    let cipher = Aes256Gcm::new_from_slice(data_key).map_err(secret_error)?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, api_key.as_bytes())
        .map_err(secret_error)?;
    let payload = EncryptedSecret {
        version: SECRET_VERSION,
        nonce: general_purpose::STANDARD.encode(nonce),
        ciphertext: general_purpose::STANDARD.encode(ciphertext),
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(secret_error)?;
    }
    let temporary_path = path.with_extension("json.tmp");
    fs::write(
        &temporary_path,
        serde_json::to_vec(&payload).map_err(secret_error)?,
    )
    .map_err(secret_error)?;
    let backup_path = path.with_extension("json.backup");
    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(secret_error)?;
    }
    let had_existing_secret = path.exists();
    if had_existing_secret {
        fs::rename(path, &backup_path).map_err(secret_error)?;
    }
    if let Err(error) = fs::rename(&temporary_path, path) {
        if had_existing_secret {
            let _ = fs::rename(&backup_path, path);
        }
        return Err(secret_error(error));
    }
    if had_existing_secret {
        fs::remove_file(backup_path).map_err(secret_error)?;
    }
    Ok(())
}

fn decrypt_secret(path: &PathBuf, data_key: &[u8; 32]) -> Result<String, String> {
    let payload: EncryptedSecret =
        serde_json::from_slice(&fs::read(path).map_err(secret_error)?).map_err(secret_error)?;
    if payload.version != SECRET_VERSION {
        return Err("不支持的密钥文件版本。".to_string());
    }
    let nonce_bytes = general_purpose::STANDARD
        .decode(payload.nonce)
        .map_err(secret_error)?;
    let nonce: [u8; 12] = nonce_bytes
        .try_into()
        .map_err(|_| "加密 nonce 长度无效。".to_string())?;
    let ciphertext = general_purpose::STANDARD
        .decode(payload.ciphertext)
        .map_err(secret_error)?;
    let plaintext = Aes256Gcm::new_from_slice(data_key)
        .map_err(secret_error)?
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "API Key 解密或完整性校验失败。".to_string())?;
    String::from_utf8(plaintext).map_err(secret_error)
}

fn secret_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join(SECRET_FILENAME))
        .map_err(secret_error)
}

fn secret_error(error: impl std::fmt::Display) -> String {
    format!("密钥存储失败：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::Instant;

    fn temporary_secret_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "my-notebook-{name}-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn aes_gcm_round_trip() {
        let path = temporary_secret_path("round-trip");
        let key: [u8; 32] = Aes256Gcm::generate_key(&mut OsRng).into();
        encrypt_secret(&path, &key, "sk-test-secret").expect("encrypt");
        assert_eq!(
            decrypt_secret(&path, &key).expect("decrypt"),
            "sk-test-secret"
        );
        encrypt_secret(&path, &key, "sk-replaced-secret").expect("replace");
        assert_eq!(
            decrypt_secret(&path, &key).expect("decrypt replacement"),
            "sk-replaced-secret"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn wrong_key_and_tampering_fail_authentication() {
        let path = temporary_secret_path("authentication");
        let key: [u8; 32] = Aes256Gcm::generate_key(&mut OsRng).into();
        let wrong_key: [u8; 32] = Aes256Gcm::generate_key(&mut OsRng).into();
        encrypt_secret(&path, &key, "sk-test-secret").expect("encrypt");
        assert!(decrypt_secret(&path, &wrong_key).is_err());

        let mut payload: EncryptedSecret =
            serde_json::from_slice(&fs::read(&path).expect("read")).expect("json");
        payload.ciphertext.push('A');
        fs::write(&path, serde_json::to_vec(&payload).expect("json")).expect("write");
        assert!(decrypt_secret(&path, &key).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn decodes_provider_key_map_and_migrates_legacy_plaintext() {
        let mapped = decode_api_keys(
            r#"{"openai":"sk-openai","anthropic":"sk-anthropic"}"#,
            "openai",
        );
        assert_eq!(mapped.get("openai").map(String::as_str), Some("sk-openai"));
        assert_eq!(
            mapped.get("anthropic").map(String::as_str),
            Some("sk-anthropic")
        );

        let legacy = decode_api_keys("sk-legacy", "deepseek");
        assert_eq!(
            legacy.get("deepseek").map(String::as_str),
            Some("sk-legacy")
        );
    }

    #[test]
    #[ignore = "diagnostic that writes a temporary OS credential"]
    fn native_keyring_and_aes_latency() {
        let account = format!("latency-test-{}", std::process::id());
        let entry = Entry::new(KEYRING_SERVICE, &account).expect("entry");
        let key: [u8; 32] = Aes256Gcm::generate_key(&mut OsRng).into();
        let encoded = general_purpose::STANDARD.encode(key);

        let set_started = Instant::now();
        entry.set_password(&encoded).expect("set credential");
        let set_elapsed = set_started.elapsed();
        let get_started = Instant::now();
        let stored = entry.get_password().expect("get credential");
        let get_elapsed = get_started.elapsed();
        assert_eq!(stored, encoded);

        let cipher = Aes256Gcm::new_from_slice(&key).expect("cipher");
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&nonce, b"sk-benchmark".as_ref())
            .expect("encrypt");
        let decrypt_started = Instant::now();
        for _ in 0..10_000 {
            let plaintext = cipher
                .decrypt(&nonce, ciphertext.as_ref())
                .expect("decrypt");
            assert_eq!(plaintext, b"sk-benchmark");
        }
        let decrypt_elapsed = decrypt_started.elapsed();
        entry.delete_credential().expect("delete credential");

        eprintln!(
            "keyring set={set_elapsed:?}, get={get_elapsed:?}, aes-gcm decrypt avg={:?}",
            decrypt_elapsed / 10_000
        );
    }

    #[test]
    #[ignore = "requires the configured real Provider credential and network access"]
    fn real_provider_agent_tool_loop_error_and_cancellation_smoke() {
        let local_app_data = std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA");
        let path = PathBuf::from(local_app_data)
            .join("com.local.mynotebook")
            .join(SECRET_FILENAME);
        let key = load_or_create_keyring_key().expect("load Provider data key");
        let plaintext = decrypt_secret(&path, &key).expect("decrypt Provider credentials");
        let keys = decode_api_keys(&plaintext, "deepseek");
        let provider = std::env::var("MYNOTEBOOK_PROVIDER_SMOKE_PROVIDER")
            .unwrap_or_else(|_| "deepseek".to_string());
        let api_key = keys
            .get(&provider)
            .filter(|value| !value.trim().is_empty())
            .expect("configured Provider API key");
        let project = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("project root");
        let status = std::process::Command::new("pnpm.cmd")
            .current_dir(project)
            .arg("exec")
            .arg("vitest")
            .arg("run")
            .arg("src/services/RealProviderSmoke.test.ts")
            .env("MYNOTEBOOK_PROVIDER_SMOKE_API_KEY", api_key)
            .env("MYNOTEBOOK_PROVIDER_SMOKE_PROVIDER", &provider)
            .env(
                "MYNOTEBOOK_PROVIDER_SMOKE_ENDPOINT",
                std::env::var("MYNOTEBOOK_PROVIDER_SMOKE_ENDPOINT")
                    .unwrap_or_else(|_| "https://api.deepseek.com".to_string()),
            )
            .env(
                "MYNOTEBOOK_PROVIDER_SMOKE_MODEL",
                std::env::var("MYNOTEBOOK_PROVIDER_SMOKE_MODEL")
                    .unwrap_or_else(|_| "deepseek-v4-pro".to_string()),
            )
            .status()
            .expect("run real Provider smoke");
        assert!(status.success(), "real Provider smoke failed");
    }
}
