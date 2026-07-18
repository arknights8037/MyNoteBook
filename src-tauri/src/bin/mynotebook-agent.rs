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
        project_id: Option<String>,
        branch_id: Option<String>,
    },
    Cognitive {
        mode: String,
        prompt: String,
        project_id: Option<String>,
        branch_id: Option<String>,
    },
    Projects,
    CreateBranch {
        project_id: String,
        title: String,
        parent_conversation_id: Option<String>,
    },
    Get {
        request_id: String,
    },
    Decide {
        request_id: String,
        action: String,
        reply: Option<String>,
        expected_summary: Option<String>,
    },
    Revise {
        request_id: String,
        feedback: String,
    },
}

impl AgentCommand {
    fn into_tool_call(self, token: &str) -> (String, Map<String, Value>) {
        let (name, value) = match self {
            Self::Submit {
                prompt,
                project_id,
                branch_id,
            } => (
                "submit_agent_request",
                json!({
                    "prompt": prompt,
                    "project_id": project_id,
                    "branch_id": branch_id,
                    "capability_token": token
                }),
            ),
            Self::Cognitive {
                mode,
                prompt,
                project_id,
                branch_id,
            } => (
                "submit_cognitive_request",
                json!({
                    "mode": mode,
                    "prompt": prompt,
                    "project_id": project_id,
                    "branch_id": branch_id,
                    "capability_token": token
                }),
            ),
            Self::Projects => ("list_agent_projects", json!({ "capability_token": token })),
            Self::CreateBranch {
                project_id,
                title,
                parent_conversation_id,
            } => (
                "create_agent_branch",
                json!({
                    "project_id": project_id,
                    "title": title,
                    "parent_conversation_id": parent_conversation_id,
                    "capability_token": token
                }),
            ),
            Self::Get { request_id } => ("get_agent_request", json!({ "request_id": request_id })),
            Self::Decide {
                request_id,
                action,
                reply,
                expected_summary,
            } => (
                "decide_agent_request",
                json!({
                    "request_id": request_id,
                    "action": action,
                    "reply": reply,
                    "expected_summary": expected_summary,
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
    let mut reply = None;
    let mut expected_summary = None;
    let mut project_id = None;
    let mut branch_id = None;
    let mut title = None;
    let mut parent_conversation_id = None;
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
            "--reply" => reply = Some(value.clone()),
            "--summary" => expected_summary = Some(value.clone()),
            "--project-id" => project_id = Some(value.clone()),
            "--branch-id" => branch_id = Some(value.clone()),
            "--title" => title = Some(value.clone()),
            "--parent-conversation-id" => parent_conversation_id = Some(value.clone()),
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
            project_id: non_empty(project_id),
            branch_id: non_empty(branch_id),
        },
        "research" | "review" | "learning" | "learn" => AgentCommand::Cognitive {
            mode: command_name,
            prompt: prompt
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "认知模式命令需要 --prompt。".to_string())?,
            project_id: non_empty(project_id),
            branch_id: non_empty(branch_id),
        },
        "projects" => AgentCommand::Projects,
        "branch" => AgentCommand::CreateBranch {
            project_id: non_empty(project_id)
                .ok_or_else(|| "branch 需要 --project-id。".to_string())?,
            title: non_empty(title).ok_or_else(|| "branch 需要 --title。".to_string())?,
            parent_conversation_id: non_empty(parent_conversation_id),
        },
        "get" => AgentCommand::Get {
            request_id: required_request_id(request_id)?,
        },
        "approve" | "reject" => AgentCommand::Decide {
            request_id: required_request_id(request_id)?,
            action: command_name,
            reply: reply.filter(|value| !value.trim().is_empty()),
            expected_summary: expected_summary.filter(|value| !value.trim().is_empty()),
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

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|item| !item.trim().is_empty())
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
    "用法：mynotebook-agent <projects|branch|submit|research|review|learning|get|approve|reject|revise> --database-url <sqlite-url> [--project-id <id>] [--branch-id <id>] [--title <分支标题>] [--parent-conversation-id <id>] [--prompt <text>] [--request-id <id>] [--feedback <text>] [--reply <审批回复>] [--summary <预期 summary>] [--server <path>]".to_string()
}
