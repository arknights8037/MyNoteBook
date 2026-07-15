use std::{env, path::PathBuf, time::Duration};

use rmcp::{model::CallToolRequestParams, transport::TokioChildProcess, ServiceExt};
use serde_json::{json, Map, Value};
use tokio::{process::Command, time::timeout};

const MCP_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let invocation = parse_invocation(env::args().skip(1).collect())?;
    let token = env::var("MYNOTEBOOK_AGENT_CAPABILITY_TOKEN")
        .map_err(|_| "请通过 MYNOTEBOOK_AGENT_CAPABILITY_TOKEN 提供能力令牌。")?;
    if token.trim().is_empty() {
        return Err("MYNOTEBOOK_AGENT_CAPABILITY_TOKEN 不能为空。".into());
    }

    let server = invocation.server.unwrap_or(default_server_path()?);
    let mut command = Command::new(server);
    command
        .arg("--database-url")
        .arg(&invocation.database_url)
        .env("MYNOTEBOOK_AGENT_CAPABILITY_TOKEN", &token);
    let transport = TokioChildProcess::new(command)?;
    let mut client = timeout(MCP_TIMEOUT, ().serve(transport))
        .await
        .map_err(|_| "MCP 初始化超时。")??;

    let (tool_name, arguments) = invocation.command.into_tool_call(&token);
    let params = CallToolRequestParams::new(tool_name).with_arguments(arguments);
    let result = timeout(MCP_TIMEOUT, client.peer().call_tool(params))
        .await
        .map_err(|_| "MCP 工具调用超时。")??;
    let _ = client.close_with_timeout(MCP_CLOSE_TIMEOUT).await;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

struct Invocation {
    database_url: String,
    server: Option<PathBuf>,
    command: AgentCommand,
}

enum AgentCommand {
    Submit {
        prompt: String,
    },
    Get {
        request_id: String,
    },
    Decide {
        request_id: String,
        action: String,
    },
    Revise {
        request_id: String,
        feedback: String,
    },
}

impl AgentCommand {
    fn into_tool_call(self, token: &str) -> (String, Map<String, Value>) {
        let (name, value) = match self {
            Self::Submit { prompt } => (
                "submit_agent_request",
                json!({ "prompt": prompt, "capability_token": token }),
            ),
            Self::Get { request_id } => ("get_agent_request", json!({ "request_id": request_id })),
            Self::Decide { request_id, action } => (
                "decide_agent_request",
                json!({
                    "request_id": request_id,
                    "action": action,
                    "capability_token": token
                }),
            ),
            Self::Revise {
                request_id,
                feedback,
            } => (
                "revise_agent_request",
                json!({
                    "request_id": request_id,
                    "feedback": feedback,
                    "capability_token": token
                }),
            ),
        };
        (
            name.to_string(),
            value.as_object().cloned().unwrap_or_default(),
        )
    }
}

fn parse_invocation(arguments: Vec<String>) -> Result<Invocation, String> {
    let command_name = arguments.first().ok_or_else(usage)?.to_string();
    let mut database_url = env::var("MYNOTEBOOK_DATABASE_URL").ok();
    let mut server = None;
    let mut prompt = None;
    let mut request_id = None;
    let mut feedback = None;
    let mut index = 1;
    while index < arguments.len() {
        let value = arguments
            .get(index + 1)
            .ok_or_else(|| format!("{} 缺少值。", arguments[index]))?;
        match arguments[index].as_str() {
            "--database-url" => database_url = Some(value.clone()),
            "--server" => server = Some(PathBuf::from(value)),
            "--prompt" => prompt = Some(value.clone()),
            "--request-id" => request_id = Some(value.clone()),
            "--feedback" => feedback = Some(value.clone()),
            option => return Err(format!("未知参数：{option}\n{}", usage())),
        }
        index += 2;
    }
    let database_url = database_url
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "请传入 --database-url 或 MYNOTEBOOK_DATABASE_URL。".to_string())?;
    let command = match command_name.as_str() {
        "submit" => AgentCommand::Submit {
            prompt: prompt
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "submit 需要 --prompt。".to_string())?,
        },
        "get" => AgentCommand::Get {
            request_id: required_request_id(request_id)?,
        },
        "approve" | "reject" => AgentCommand::Decide {
            request_id: required_request_id(request_id)?,
            action: command_name,
        },
        "revise" => AgentCommand::Revise {
            request_id: required_request_id(request_id)?,
            feedback: feedback
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "revise 需要 --feedback。".to_string())?,
        },
        _ => return Err(usage()),
    };
    Ok(Invocation {
        database_url,
        server,
        command,
    })
}

fn required_request_id(value: Option<String>) -> Result<String, String> {
    value
        .filter(|item| !item.trim().is_empty())
        .ok_or_else(|| "该命令需要 --request-id。".to_string())
}

fn default_server_path() -> Result<PathBuf, String> {
    let mut path = env::current_exe().map_err(|error| error.to_string())?;
    path.set_file_name(if cfg!(windows) {
        "mynotebook-mcp.exe"
    } else {
        "mynotebook-mcp"
    });
    Ok(path)
}

fn usage() -> String {
    "用法：mynotebook-agent <submit|get|approve|reject|revise> --database-url <sqlite-url> [--prompt <text>] [--request-id <id>] [--feedback <text>] [--server <path>]".to_string()
}
