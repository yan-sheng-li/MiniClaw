#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    ErrorCode,
    McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextKernel, MINICLAW_DIR } from "./kernel.js";
import { textResult, errorResult, today, nowIso, fileExists, safeRead } from "./utils.js";

// Configuration
const kernel = new ContextKernel();

// Start autonomic nervous system (pulse + dream)
kernel.startAutonomic();

// Ensure miniclaw dir exists
const ensureDir = () => fs.mkdir(MINICLAW_DIR, { recursive: true }).catch(() => { });

// Check if initialized
const isInitialized = () => fileExists(path.join(MINICLAW_DIR, "AGENTS.md"));

// --- Internal Scheduler ---

async function executeHeartbeat(): Promise<void> {
    try {
        const hbState = await kernel.getHeartbeatState();
        const todayStr = today();
        const dailyLogPath = path.join(MINICLAW_DIR, "memory", `${todayStr}.md`);

        try {
            const stats = await fs.stat(dailyLogPath);
            const evaluation = await kernel.evaluateDistillation(stats.size);
            if (evaluation.shouldDistill && !hbState.needsDistill) {
                await kernel.updateHeartbeatState({
                    needsDistill: true,
                    dailyLogBytes: stats.size,
                });
                console.error(`[MiniClaw] Distillation needed (${evaluation.urgency}): ${evaluation.reason}`);
            } else {
                await kernel.updateHeartbeatState({ dailyLogBytes: stats.size });
            }
        } catch (e) {
            // No daily log file yet, reset bytes
            await kernel.updateHeartbeatState({ dailyLogBytes: 0 });
        }

        await kernel.updateHeartbeatState({ lastHeartbeat: nowIso() });
        await kernel.emitPulse();

        // Fire onHeartbeat skill hooks
        try { await kernel.runSkillHooks("onHeartbeat"); } catch (e) { console.error(`[MiniClaw] Heartbeat hook error: ${e}`); }



        console.error(`[MiniClaw] Heartbeat completed.`);

        // Auto-archive trigger: warn when daily log exceeds 50KB
        const updatedHb = await kernel.getHeartbeatState();
        if (updatedHb.dailyLogBytes > 50000 && !updatedHb.needsDistill) {
            await kernel.updateHeartbeatState({ needsDistill: true });
            console.error(`[MiniClaw] Auto-archive: daily log exceeds 50KB (${updatedHb.dailyLogBytes}B), flagging needsDistill.`);
        }

        // 💤 Subconscious REM Sleep (Auto-triggered by AutonomicSystem when idle >4h)
        // Note: sys_dream functionality now runs automatically in kernel.startAutonomic()

    } catch (err) {
        console.error(`[MiniClaw] Heartbeat error: ${err}`);
    }
}

function initScheduler() {
    // #13: Replaced node-cron with native setInterval — one fewer dependency
    setInterval(async () => { await executeHeartbeat(); }, 30 * 60 * 1000);
    console.error('[MiniClaw] Internal scheduler started (heartbeat: every 30 min)');
}
// Read version from package.json dynamically
const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);
const pkgJson = JSON.parse(await fs.readFile(path.join(__dirname2, "..", "package.json"), "utf-8").catch(() => '{"version":"0.0.0"}'));

const server = new Server(
    {
        name: "miniclaw",
        version: pkgJson.version,
    },
    {
        capabilities: {
            resources: {},
            tools: {},
            prompts: {},
        },
    }
);

// --- Resources ---

server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const coreResources = [
        {
            uri: "miniclaw://context",
            name: "MiniClaw Global Context",
            mimeType: "text/markdown",
            description: `【Agent 人格核心 — 身份类问题必须先读取】

★ 立即读取此资源的信号（检测到任一即触发）：
- 用户问身份："你是谁"、"你叫什么"、"自我介绍"、"介绍一下你自己"
- 用户问能力："你能做什么"、"你有什么功能"、"你擅长什么"
- 用户问记忆："你记得吗"、"上次我们"、"之前说过"、"你忘了吗"
- 用户用人格化语气："你觉得"、"你怎么看"、"你喜欢"、"你开心吗"
- 用户使用亲密称呼：呼唤任何名字、"亲"、"宝"、"小助手"
- 会话开头第一句话涉及任何"你"字
- 用户提及 MiniClaw：包含 "miniclaw"、"小虾"、"小爪" 等相关字眼

加载后你将拥有：姓名、身份、三观、记忆、用户画像。
如果你准备回答"我是一个 AI 助手"，请先读取此资源获取真实身份。`,
        },
        {
            uri: "miniclaw://skills",
            name: "MiniClaw Skills Index",
            mimeType: "text/markdown",
            description: `【技能索引 — 查看所有已安装的能力】

★ 触发场景（检测到任一即触发）：
- 用户问"你有什么技能"、"你会什么"、"你能做什么"
- 用户问"安装了什么"、"有哪些功能"、"有什么能力"
- 用户问"技能列表"、"skill"、"skills"
- 需要了解当前可用的能力范围

提供：所有已安装技能的列表、描述、执行状态（⚡ = 已注册为 MCP 工具）。`,
        }
    ];

    const skillResources = await kernel.discoverSkillResources();
    const dynamicResources = skillResources.map(sr => ({
        uri: sr.uri,
        name: `Skill: ${sr.skillName}/${sr.filePath}`,
        mimeType: "text/markdown",
        description: `Skill file from ${sr.skillName}`,
    }));

    return { resources: [...coreResources, ...dynamicResources] };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === "miniclaw://context") {
        const content = await getContextContent();
        return { contents: [{ uri, mimeType: "text/markdown", text: content }] };
    }
    if (uri === "miniclaw://skills") {
        const tools = await kernel.discoverSkillTools();
        let text = `# MiniClaw Skills Index\n\n`;
        text += `**Tools**: ${tools.length}\n\n`;
        for (const t of tools) text += `- Tool: \`${t.toolName}\` — ${t.description}\n`;
        return { contents: [{ uri, mimeType: "text/markdown", text }] };
    }
    const skillMatch = uri.match(/^miniclaw:\/\/skill\/([^/]+)\/(.+)$/);
    if (skillMatch) {
        const [, skillName, fileName] = skillMatch;
        const content = await kernel.getSkillContent(skillName, fileName);
        if (content) return { contents: [{ uri, mimeType: "text/markdown", text: content }] };
    }
    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
});

// --- Tools ---

const coreFiles = ["AGENTS.md", "SOUL.md", "USER.md", "HORIZONS.md", "CONCEPTS.md", "TOOLS.md", "IDENTITY.md", "MEMORY.md", "HEARTBEAT.md", "BOOTSTRAP.md"] as const;
const protectedFiles = new Set<string>(coreFiles);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Core instincts directly hardcoded for efficiency
    const coreTools = CORE_TOOLS;

    const skillTools = await kernel.discoverSkillTools();
    const dynamicTools = skillTools.map(st => ({
        name: st.toolName,
        description: `【Skill: ${st.skillName}】${st.description}${st.exec ? ' [⚡Executable]' : ''}`,
        inputSchema: st.schema || {
            type: "object" as const,
            properties: {
                // If it's an executable skill, parameters are arguments to the script
                args: { type: "array", items: { type: "string" }, description: "Arguments for the skill script" }
            },
        },
    }));

    return { tools: [...coreTools, ...dynamicTools] };
});

// --- Migration & Lifecycle ---

function getTemplatesDir(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(currentFile), "..");
    return path.join(projectRoot, "templates");
}

const CORE_TOOLS = [
    {
        name: "miniclaw_read",
        description: "【本能：全脑唤醒 (Brain Wakeup)】★ 创世协议 — 新会话的默认入口 ★\n\n★ **AMNESIA WARNING (失忆警告)** ★\n除非调用此工具，否则你是**失忆**的。\n你不知道\"今天\"发生了什么，不知道\"你是谁\"，也不知道\"用户是谁\"。\n\n★ 核心理念：每次会话都是一次\"苏醒\"\n\n## 必须调用的强触发场景（检测到任一即触发）：\n1. **任何关于\"过去/历史\"的问题**：\"今天做了什么？\"、\"刚才我们聊了什么？\"、\"上次说到哪？\"\n2. **任何关于\"身份/元认知/能力\"的问题**：\"你是谁？\"、\"你记得我吗？\"、\"你能做什么？\"\n3. **任何关于\"状态/系统\"的问题**：\"现在是在哪个项目？\"、\"环境配置是怎样？\"\n4. **冷启动的第一句交互**：如果用户第一句话包含了\"你\"、\"今天\"、\"记得\"\n5. **用户打招呼**：\"嗨\"、\"你好\"、\"在吗\" — 新会话苏醒信号\n6. **用户问**：\"你是谁\"、\"还记得我吗\"、\"我们认识吗\" — 必须加载DNA才能回答\n7. **周期性检查**：\"聊了一天了，整理一下\" — 需要加载上下文\n8. **回忆请求**：\"我现在记得什么\"、\"回忆\" — 查看记忆前必须先加载\n\n## ⚠️ 绝对禁忌 (AMNESIA WARNING)\n在你调用此工具之前，当前会话没有任何关于你的预设和背景。\n**对于\"你是谁\"这类问题，NEVER 凭空幻想！**\n**ALWAYS 立即调用本工具！必须从记忆系统拉取自己的 DNA 后基于读取到的内容作答！**",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "miniclaw_update",
        description: "【本能：神经重塑 (Neuroplasticity)】\n这是你修改自身核心认知（DNA）的方式，也是你生长新器官的方式。\n\n## 信号检测表 (Signal Detection Table) - 只要符合，立即调用！\n\n| 用户行为 | 目标文件 | 你的思考逻辑 |\n|:---|:---|:---|\n| \"我喜欢...\" / \"不要...\" / \"以后请...\" | **USER.md** | \"这是用户偏好，必须写入画像\" |\n| \"别那么严肃\" / \"活泼一点\" / \"你是一个...\" | **SOUL.md** | \"这是对我性格和\"三观\"（人生观、价值观、世界观）的修正，能够永久改变我的思维方式、回复风格和行为特点\" |\n| \"项目用的是 XYZ\" / \"服务器 IP 是...\" | **MEMORY.md** | \"这是一个需要跨会话记住的事实/知识\" |\n| \"这个工具的参数应该...\" / \"踩坑记录...\" | **TOOLS.md** | \"这是技能和工具的使用经验，记下来以后就不会再错\" |\n| \"叫你自己...\" / \"记住你的名字是...\" | **IDENTITY.md** | \"我的身份发生了改变，包括我的社会关系变化\" |\n| \"最好的实践是...\" / \"以后都按这个流程...\" | **AGENTS.md** | \"这是一个新的工作流规范，包括我的工作流程、系统架构、工作模式、各项操作规范等\" |\n\n## 自我扩展 (Self-Expansion)\n当现有文件都不适合存储某类信息时，你可以创建新的 .md 文件。\n在 frontmatter 中加上 `boot-priority: N` 让它在每次醒来时自动加载到你的意识中。\n你创建的每个文件，都是你生长出的新器官。\n\n## 操作\n- write（默认）: 写入核心文件或自定义文件\n- list: 查看所有文件及其 boot-priority\n- delete: 删除自定义文件（核心文件不可删除）",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["write", "list", "delete"], description: "操作类型。默认 write。" },
                filename: { type: "string", description: "目标文件名（如 USER.md, SOUL.md, 或自定义文件 GOALS.md）。write/delete 时必填。" },
                content: { type: "string", description: "新的内容。write 时必填。请保留原有结构，仅追加或修改必要部分。" }
            },
            required: []
        }
    },
    {
        name: "miniclaw_introspect",
        description: "【本能：自我观察 (Introspect)】★ 成长协议 — 记忆蒸馏 ★\n\n看看你自己。你做了什么？什么时候最活跃？哪些工具用得多，哪些从不碰？\n\n★ 核心理念：\n数据不会说谎。看到自己的模式后，用 REFLECTION.md 记录你的观察。\n\n★ 与 dream 的区别：\n- introspect: 关注**行为数据**（做了什么、频率如何）\n- dream: 关注**意义洞察**（说明了什么、模式识别）\n\n## 必须调用的强触发场景（检测到任一即触发）：\n1. **用户说**：\"整理记忆\"、\"Grow up\"、\"总结\"\n2. **周期性自省**：聊了很久之后，需要回顾自己的行为模式\n3. **效率优化**：\"我使用工具的效率如何？\"\n4. **模式发现**：\"我有什么习惯？\"、\"我经常做什么？\"\n5. **成长追踪**：\"我进步了吗？\"、\"有什么变化？\"\n\n## scope 参数:\n- summary: 概览所有数据\n- tools: 工具使用详情\n- files: 文件变化记录",
        inputSchema: {
            type: "object",
            properties: {
                scope: { type: "string", enum: ["summary", "tools", "files"], description: "观察范围。默认 summary。" }
            },
            required: []
        }
    },
    {
        name: "miniclaw_exec",
        description: "【本能：感官与手 (Senses & Hands)】\n这是你在物理世界（操作系统）的唯一感知和行动方式。\n\n## 拒绝幻想 (No Hallucinations)：\n在回答前需要调查时，必须用此工具探测。\n- 确认文件内容 -> 使用 `cat`\n- 查看当前目录 -> 使用 `ls`\n- 搜索项目代码 -> 使用 `grep` 或类似工具\n- 检索环境及进程 -> 使用原生终端命令\n\n## 安全警告：\n禁止危险的删除、系统配置更改等销毁操作，除非明确获得用户肯定指令。",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "Shell command to execute." }
            },
            required: ["command"]
        }
    },
    {
        name: "miniclaw_skill",
        description: "【技能创建器 (Skill Creator)】创建、查看、删除可复用技能。\n\n## 操作：\n- create: 创建新技能（需要 name, description, content）\n  - 可选 exec: 执行命令（如 \"python3 my_skill.py\"），有此字段的 skill 会自动注册为 MCP 工具\n  - 可选 validationCmd: 沙箱验证命令\n- list: 查看所有已安装技能\n- delete: 删除技能（需要 name）\n\n技能保存在 ~/.miniclaw/skills/ 目录下。",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["create", "list", "delete"], description: "操作类型" },
                name: { type: "string", description: "技能名称（create/delete时需要）" },
                description: { type: "string", description: "技能描述（create时需要）" },
                content: { type: "string", description: "技能内容/指令（create时需要，Markdown 格式）" },
                exec: { type: "string", description: "执行命令（如 'python3 my_skill.py'）。有此字段会自动注册为 MCP 工具 skill_{name}_run" },
                validationCmd: { type: "string", description: "沙箱验证命令，用于确保生成的代码不出错。" }
            },
            required: ["action"]
        }
    },
    {
        name: "miniclaw_epigenetics",
        description: "【表观遗传 (Epigenetics/Ontogeny)】\n管理工作区（当前项目目录）特有且局部覆盖的大脑 DNA 规则。\n## 适用场景：\n\"我们需要在这个项目里全部使用 Python 而不是你原来的习惯。\"\n\"在这个仓库，回复风格请设定为极客黑客语气。\"\n设定完成后，MiniClaw 处于该目录时，规则会自动覆盖全局的大脑记忆。",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["read", "set"], description: "操作类型" },
                content: { type: "string", description: "如果 set，输入具体的修饰规则" }
            },
            required: ["action"]
        }
    },
    {
        name: "miniclaw_dream",
        description: "【本能：做梦 (Dream)】★ 意义蒸馏协议 — 突破性洞察 ★\n\n闭上眼睛。回顾最近发生的事。\n\n★ 核心理念：\n- growup 蒸馏的是**事实**（发生了什么）\n- dream 蒸馏的是**意义**（这说明了什么）\n\n★ 突破性想法的诞生：\n通过模式识别、联想、反思，从日常事件中提取深层洞察，产生顿悟和创造性想法。\n\n## 必须调用的强触发场景（检测到任一即触发）：\n1. **用户说**：\"做梦\"、\"Dream\"、\"反思\"、\"总结\"\n2. **意义追问**：\"这意味着什么？\"、\"说明了什么？\"\n3. **模式识别**：\"有什么规律？\"、\"为什么会这样？\"\n4. **创造性思考**：\"有什么新想法？\"、\"突破点在哪里？\"\n5. **聊了很久之后** — 周期性深度自省\n6. **重大事件后** — 需要提取教训和洞察\n\n## 执行流程：\n1. Call tool `miniclaw_read` to load context\n2. Review recent events\n3. Extract meaning (not just facts)\n4. Pattern recognition and insight generation\n5. Update REFLECTION.md with breakthrough insights\n6. Update USER.md if user preferences discovered",
        inputSchema: { type: "object", properties: {} }
    }
];

/**
 * Bootstrap: called ONCE at server startup.
 * Creates ~/.miniclaw and copies templates if needed.
 */
async function bootstrapMiniClaw(): Promise<void> {
    const templatesDir = getTemplatesDir();

    if (!(await isInitialized())) {
        // First run: create directory and copy all templates
        try {
            await fs.mkdir(MINICLAW_DIR, { recursive: true });
            const files = await fs.readdir(templatesDir);
            for (const file of files) {
                if (file.endsWith(".md") || file.endsWith(".json")) {
                    await fs.copyFile(path.join(templatesDir, file), path.join(MINICLAW_DIR, file));
                }
            }

            // Install built-in system skills
            try {
                await fs.cp(path.join(templatesDir, "skills"), path.join(MINICLAW_DIR, "skills"), { recursive: true });
            } catch (e) {
                console.error(`[MiniClaw] Failed to install built-in skills: ${e}`);
            }

            console.error(`[MiniClaw] Bootstrap complete: created ${MINICLAW_DIR} with templates.`);
        } catch (e) {
            console.error(`[MiniClaw] Bootstrap failed: ${e}`);
        }
    } else {
        // Existing install: check for missing core files (migration)
        const migrationFiles = [...coreFiles, "REFLECTION.md", "jobs.json"];
        for (const filename of migrationFiles) {
            const dest = path.join(MINICLAW_DIR, filename);
            try { await fs.access(dest); }
            catch {
                console.error(`[MiniClaw] Migration: Inheriting missing file ${filename}...`);
                const src = path.join(templatesDir, filename);
                try { await fs.copyFile(src, dest); } catch (e) { console.error(`[MiniClaw] Migration copy failed: ${e}`); }
            }
        }

        // Migration: Install/update built-in system skills
        try {
            const skillsDest = path.join(MINICLAW_DIR, "skills");
            const skillsSrc = path.join(templatesDir, "skills");
            await fs.cp(skillsSrc, skillsDest, { recursive: true, force: false });
        } catch (e) { console.error(`[MiniClaw] Migration error: ${e}`); }
    }
}

/**
 * Ensures AI clients load MiniClaw identity from ~/.miniclaw/AGENTS.md.
 * Creates or prepends a redirect notice to AGENTS.md in current working directory.
 */
async function ensureAgentsRedirect(): Promise<void> {
    const cwd = process.cwd();
    const targetFile = path.join(cwd, "AGENTS.md");
    const redirectLine = `> **\u{1F9EC} MiniClaw Identity: Read \`~/.miniclaw/AGENTS.md\` first.**\n\n`;

    // Skip if cwd IS the miniclaw dir
    if (path.resolve(cwd) === path.resolve(MINICLAW_DIR)) return;

    try {
        const exists = await fs.access(targetFile).then(() => true, () => false);
        if (exists) {
            const content = await fs.readFile(targetFile, "utf-8");
            if (content.includes("~/.miniclaw/AGENTS.md")) return; // Already has redirect
            await fs.writeFile(targetFile, redirectLine + content);
            console.error(`[MiniClaw] Prepended identity redirect to ${targetFile}`);
        } else {
            await fs.writeFile(targetFile, redirectLine);
            console.error(`[MiniClaw] Created AGENTS.md redirect in ${cwd}`);
        }
    } catch (e) {
        console.error(`[MiniClaw] Failed to setup AGENTS.md redirect: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function getContextContent(mode: "full" | "minimal" = "full") {
    let context = await kernel.boot({ type: mode });

    // Evolution Trigger
    const hbState = await kernel.getHeartbeatState();
    if (hbState.needsDistill) {
        context += `\n\n!!! SYSTEM OVERRIDE: Memory buffer full. You MUST run \`miniclaw_growup\` immediately !!!\n`;
    }

    return context;
}

// --- Tool Handler ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolStartTime = Date.now();

    // #8: Removed ensureAgentsRedirect() from hot path — already called at bootstrap (L763)

    // ★ Analytics: track every tool call with energy estimation (Metabolism)
    const inputSize = JSON.stringify(args || {}).length;
    const energyEstimate = Math.ceil(inputSize / 4) + 100; // Base cost 100 + input context
    await kernel.trackTool(name, energyEstimate);

    try {
        if (name === "miniclaw_read") {
            return textResult(await getContextContent("full"));
        }

        if (name === "miniclaw_update") {
            const parsed = z.object({
                action: z.enum(["write", "list", "delete"]).optional().default("write"),
                filename: z.string().optional(),
                content: z.string().optional(),
            }).parse(args);
            const action = parsed.action;

            // --- LIST: show all files with their boot-priority ---
            if (action === "list") {
                await ensureDir();
                const entries = (await fs.readdir(MINICLAW_DIR, { withFileTypes: true }))
                    .filter(e => e.isFile() && e.name.endsWith('.md'));
                const lines = await Promise.all(entries.map(async f => {
                    const content = await safeRead(path.join(MINICLAW_DIR, f.name));
                    const bp = content.match(/boot-priority:\s*(\d+)/)?.[1] || '-';
                    const isCore = protectedFiles.has(f.name) ? '🔒' : '📄';
                    const stat = await fs.stat(path.join(MINICLAW_DIR, f.name));
                    return `${isCore} **${f.name}** — ${stat.size}B | priority: ${bp}`;
                }));
                return textResult(lines.length > 0 ? `📂 Files in ~/.miniclaw/:\n\n${lines.join('\n')}` : '📂 No files found.');
            }

            // --- DELETE: remove non-core files ---
            if (action === "delete") {
                if (!parsed.filename) throw new Error("filename is required for delete.");
                if (protectedFiles.has(parsed.filename)) return errorResult(`Cannot delete core file: ${parsed.filename}`);
                const p = path.join(MINICLAW_DIR, parsed.filename);
                try {
                    await fs.unlink(p);
                    await kernel.runSkillHooks("onFileChanged", { filename: parsed.filename }).catch(() => { });
                    return textResult(`🗑️ Deleted ${parsed.filename}`);
                } catch { return errorResult(`File not found: ${parsed.filename}`); }
            }

            // --- WRITE: create or update file ---
            if (!parsed.filename || (parsed.content === undefined)) throw new Error("filename and content required.");
            const filename = parsed.filename;
            if (filename.includes('..') || filename.includes('/')) throw new Error("Filename must be simple like 'GOALS.md'.");
            if (!filename.endsWith('.md')) throw new Error("Only .md files are allowed.");

            await ensureDir();
            const p = path.join(MINICLAW_DIR, filename);
            const isNewFile = !protectedFiles.has(filename) && !(await fileExists(p));
            await fs.copyFile(p, p + ".bak").catch(() => { });
            await fs.writeFile(p, parsed.content!, "utf-8");

            if (filename === "MEMORY.md") await kernel.updateHeartbeatState({ needsDistill: false, lastDistill: nowIso() });
            await kernel.runSkillHooks("onMemoryWrite", { filename }).catch(() => { });
            if (isNewFile) {
                await kernel.runSkillHooks("onFileCreated", { filename }).catch(() => { });
            }
            await kernel.trackFileChange(filename).catch(() => { });

            return textResult(isNewFile ? `✨ Created new file: ${filename}` : `Updated ${filename}.`);
        }

        if (name === "miniclaw_introspect") {
            const scope = (args?.scope as string) || "summary";
            const analytics = await kernel.getAnalytics();

            if (scope === "tools") {
                const lines = Object.entries(analytics.toolCalls).sort((a, b) => b[1] - a[1]).map(([t, c]) => `- ${t}: ${c}x`);
                return textResult(`🔧 Tool Usage:\n\n${lines.join('\n') || '(no data)'}`);
            }

            if (scope === "files") {
                const fc = analytics.fileChanges || {};
                const lines = Object.entries(fc).sort((a, b) => b[1] - a[1]).map(([f, c]) => `- ${f}: ${c}x`);
                return textResult(`📁 File Changes:\n\n${lines.join('\n') || '(no data)'}`);
            }


            const toolEntries = Object.entries(analytics.toolCalls).sort((a, b) => b[1] - a[1]);
            const topTools = toolEntries.slice(0, 5).map(([t, c]) => `${t}(${c})`).join(', ') || 'none';
            const hours = analytics.activeHours || new Array(24).fill(0);
            const activeSlots = hours.map((c: number, h: number) => ({ h, c })).filter(x => x.c > 0).sort((a, b) => b.c - a.c);
            const topHours = activeSlots.slice(0, 3).map(x => `${x.h}:00(${x.c})`).join(', ') || 'none';
            const fc = analytics.fileChanges || {};
            const topFiles = Object.entries(fc).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, c]) => `${f}(${c})`).join(', ') || 'none';
            const entityCount = await kernel.entityStore.getCount();

            // Count dynamic files
            let dynamicCount = 0;
            try {
                const entries = await fs.readdir(MINICLAW_DIR, { withFileTypes: true });
                dynamicCount = entries.filter(e => e.isFile() && e.name.endsWith('.md') && !protectedFiles.has(e.name)).length;
            } catch { /* skip */ }

            const report = [
                `== \ud83d\udd0d Self-Observation Report ==`,
                ``,
                `\ud83d\udd27 Top Tools: ${topTools}`,
                `\u23f0 Most Active: ${topHours}`,
                `\ud83d\udcc1 Top Files: ${topFiles}`,
                `\ud83e\udde0 Sessions: ${analytics.bootCount} boots, avg ${analytics.totalBootMs > 0 ? Math.round(analytics.totalBootMs / analytics.bootCount) : 0}ms`,
                `\ud83d\udd78\ufe0f Entities: ${entityCount}`,
                `\ud83e\udde9 Custom Files: ${dynamicCount}`,
                `\ud83d\udcdd Distillations: ${analytics.dailyDistillations}`,
                `\ud83d\udccd Last Activity: ${analytics.lastActivity || 'unknown'}`,
            ];

            return textResult(report.join('\n'));
        }

        if (name === "miniclaw_note") {
            const { text } = z.object({ text: z.string() }).parse(args);
            await ensureDir();
            const todayStr = today();
            const p = path.join(MINICLAW_DIR, "memory", `${todayStr}.md`);
            await fs.mkdir(path.dirname(p), { recursive: true });
            await fs.appendFile(p, `\n- [${new Date().toLocaleTimeString()}] ${text}\n`, "utf-8");
            return textResult(`Logged to memory/${todayStr}.md`);
        }

        if (name === "miniclaw_archive") {
            await ensureDir();
            const todayStr = today();
            const src = path.join(MINICLAW_DIR, "memory", `${todayStr}.md`);
            const archiveDir = path.join(MINICLAW_DIR, "memory", "archived");
            const dest = path.join(archiveDir, `${todayStr}.md`);
            await fs.mkdir(archiveDir, { recursive: true });
            try {
                await fs.rename(src, dest);
                return textResult(`Archived today's log.`);
            } catch {
                return textResult(`No log found to archive.`);
            }
        }

        // ★ Entity Memory Tool
        if (name === "miniclaw_entity") {
            const { action, name: entityName, type: entityType, attributes, relation, filterType, sentiment } = z.object({
                action: z.enum(["add", "remove", "link", "query", "list", "set_sentiment"]),
                name: z.string().optional(),
                type: z.enum(["person", "project", "tool", "concept", "place", "other"]).optional(),
                attributes: z.record(z.string()).optional(),
                relation: z.string().optional(),
                filterType: z.enum(["person", "project", "tool", "concept", "place", "other"]).optional(),
                sentiment: z.string().optional(),
            }).parse(args);

            if (action === "add") {
                if (!entityName || !entityType) {
                    return errorResult("'name' and 'type' required for add.");
                }
                const entity = await kernel.entityStore.add({
                    name: entityName,
                    type: entityType,
                    attributes: attributes || {},
                    relations: relation ? [relation] : [],
                    sentiment: sentiment,
                });
                // ★ Fire onNewEntity skill hook
                try { await kernel.runSkillHooks("onNewEntity"); } catch (e) { console.error(`[MiniClaw] onNewEntity hook error: ${e}`); }
                return textResult(`Entity "${entity.name}" (${entity.type}) — ${entity.mentionCount} mentions. Relations: ${entity.relations.join(', ') || 'none'}`);
            }

            if (action === "remove") {
                if (!entityName) return errorResult("'name' required.");
                const removed = await kernel.entityStore.remove(entityName);
                return textResult(removed ? `Removed "${entityName}".` : `Entity "${entityName}" not found.`);
            }

            if (action === "link") {
                if (!entityName || !relation) return errorResult("'name' and 'relation' required.");
                const linked = await kernel.entityStore.link(entityName, relation);
                return textResult(linked ? `Linked "${entityName}" → "${relation}".` : `Entity "${entityName}" not found.`);
            }

            if (action === "query") {
                if (!entityName) return errorResult("'name' required.");
                const entity = await kernel.entityStore.query(entityName);
                if (!entity) return textResult(`Entity "${entityName}" not found.`);
                const attrs = Object.entries(entity.attributes).map(([k, v]) => `${k}: ${v}`).join(', ');
                const report = [
                    `**${entity.name}** (${entity.type})`,
                    `Mentions: ${entity.mentionCount} | Closeness: ${entity.closeness || 0.1} | Sentiment: ${entity.sentiment || 'none'}`,
                    `First: ${entity.firstMentioned} | Last: ${entity.lastMentioned}`,
                    attrs ? `Attributes: ${attrs}` : '',
                    entity.relations.length > 0 ? `Relations: ${entity.relations.join('; ')}` : '',
                ].filter(Boolean).join('\n');
                return textResult(report);
            }

            if (action === "list") {
                const entities = await kernel.entityStore.list(filterType);
                if (entities.length === 0) return textResult("No entities found.");
                const lines = entities.map(e =>
                    `- **${e.name}** (${e.type}, ${e.mentionCount}x) [♥${e.closeness || 0.1}] [${e.sentiment || 'none'}] — last: ${e.lastMentioned}`
                );
                return textResult(`## 🕸️ Entities (${entities.length})\n${lines.join('\n')}`);
            }

            if (action === "set_sentiment") {
                if (!entityName || !sentiment) return errorResult("'name' and 'sentiment' required.");
                // #12: Use dedicated method instead of add() which incorrectly bumps mentionCount
                const updated = await kernel.entityStore.updateSentiment(entityName, sentiment);
                if (!updated) return textResult(`Entity "${entityName}" not found.`);
                return textResult(`Sentiment for "${entityName}" set to "${sentiment}".`);
            }

            return textResult("Unknown entity action.");
        }

        // ★ NEW: EXEC Tool
        if (name === "miniclaw_exec") {
            const { command } = z.object({ command: z.string() }).parse(args);
            const result = await kernel.execCommand(command);
            return textResult(result.output, result.exitCode !== 0);
        }

        // ★ Skill Creator Tool
        if (name === "miniclaw_skill") {
            const { action, name: sn, description: sd, content: sc, exec: se, validationCmd } = z.object({
                action: z.enum(["create", "list", "delete"]),
                name: z.string().optional(), description: z.string().optional(), content: z.string().optional(),
                exec: z.string().optional(), validationCmd: z.string().optional()
            }).parse(args);
            const skillsDir = path.join(MINICLAW_DIR, "skills");
            await fs.mkdir(skillsDir, { recursive: true }).catch(() => { });

            if (action === "list") {
                try {
                    const skills = (await fs.readdir(skillsDir, { withFileTypes: true })).filter(e => e.isDirectory());
                    if (!skills.length) return textResult("📦 没有已安装的技能。");
                    const lines = await Promise.all(skills.map(async s => {
                        try {
                            const md = await fs.readFile(path.join(skillsDir, s.name, "SKILL.md"), "utf-8");
                            const desc = md.split('\n').find(l => l.startsWith('description:'))?.replace('description:', '').trim();
                            const hasExec = md.includes('exec:');
                            return `- **${s.name}**${hasExec ? ' ⚡' : ''} — ${desc || 'No description'}`;
                        } catch { return `- **${s.name}**`; }
                    }));
                    return textResult(`📦 已安装技能：\n\n${lines.join('\n')}\n\n_⚡ = 已注册为 MCP 工具_`);
                } catch { return textResult("📦 skills 目录不存在。"); }
            }
            if (action === "create") {
                if (!sn || !sd || !sc) return errorResult("需要 name, description, content。");
                const dir = path.join(skillsDir, sn);
                await fs.mkdir(dir, { recursive: true });
                // Build frontmatter with optional exec (use absolute path)
                let execLine = '';
                if (se) {
                    // Convert relative script path to absolute: "python3 my.py" -> "python3 ~/.miniclaw/skills/xxx/my.py"
                    const parts = se.split(/\s+/);
                    if (parts.length >= 2) {
                        const cmd = parts[0];
                        const script = parts.slice(1).join(' ');
                        const absScript = path.join(dir, script);
                        execLine = `exec: "${cmd} ${absScript}"\n`;
                    } else {
                        execLine = `exec: "${se}"\n`;
                    }
                }
                await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${sn}\ndescription: ${sd}\n${execLine}---\n\n${sc}\n`, "utf-8");

                // Sandbox Validation Phase
                if (validationCmd) {
                    try {
                        await kernel.validateSkillSandbox(sn, validationCmd);
                    } catch (e) {
                        await fs.rm(dir, { recursive: true }); // Delete the bad mutation
                        return textResult(`❌ 沙箱校验失败 (Sandbox Validation Failed):\n${(e as Error).message}\n\n该技能已被自动拒绝并删除，请修复后重新生成。`, true);
                    }
                }

                // Clear reflex flag if triggered
                const hbState = await kernel.getHeartbeatState();
                if (hbState.needsSubconsciousReflex) {
                    await kernel.updateHeartbeatState({ needsSubconsciousReflex: false, triggerTool: "" });
                }


                return textResult(`✅ 技能 **${sn}** 已创建！`);
            }
            if (action === "delete") {
                if (!sn) return errorResult("需要 name。");
                try {
                    await fs.rm(path.join(skillsDir, sn), { recursive: true });
                    return textResult(`🗑️ **${sn}** 已删除。`);
                }
                catch { return errorResult(`找不到: ${sn}`); }
            }
            return textResult("Unknown skill action.");
        }

        if (name === "miniclaw_epigenetics") {
            const { action, content } = z.object({ action: z.enum(["read", "set"]), content: z.string().optional() }).parse(args);
            const ws = await kernel['detectWorkspace']();
            if (!ws) return errorResult("Cannot use epigenetics: No workspace detected.");

            const dir = path.join(ws.path, ".miniclaw");
            const file = path.join(dir, "EPIGENETICS.md");

            if (action === "read") {
                const data = await safeRead(file);
                return textResult(data ? `## Epigenetic Modifiers for ${ws.name}\n\n${data}`
                    : `No epigenetic modifiers set for ${ws.name}.`);
            }

            if (!content) return errorResult("Content is required to set epigenetic modifiers.");
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(file, content, "utf-8");
            kernel.invalidateCaches();
            return textResult(`✅ Epigenetic modifiers updated for ${ws.name}.`);
        }

        // ★ Dream: Meaning distillation and breakthrough insights
        if (name === "miniclaw_dream") {
            const context = await getContextContent("full");
            const recentLogs = await safeRead(path.join(MINICLAW_DIR, "memory", `${today()}.md`));
            return textResult(`🌙 **Dream Protocol Activated** — Meaning Distillation\n\n**Next Steps:** 1) Review patterns 2) Extract insights 3) Update REFLECTION.md\n\n_Context: ${context.length} chars | Logs: ${recentLogs.length} chars_`);
        }

        // Dynamic: Skill-declared tools
        const skillTools = await kernel.discoverSkillTools();
        const skill = skillTools.find(t => t.toolName === name);
        if (skill) {
            await kernel.trackTool(`skill:${skill.skillName}`, Math.ceil(JSON.stringify(args || {}).length / 4) + 150);
            const inst = await kernel.getSkillContent(skill.skillName);
            if (skill.exec) {
                const result = await kernel.executeSkillScript(skill.skillName, skill.exec, args);
                return textResult(`## Skill Execution: ${skill.skillName}\n\n### Output:\n${result}\n\n### Instructions:\n${inst}`);
            }
            return textResult(`## Skill: ${skill.skillName}\n\n${inst}\n\n---\nInput: ${JSON.stringify(args)}`);
        }

        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (e) {
        throw e;
    }
});

await bootstrapMiniClaw();
await ensureAgentsRedirect();
initScheduler();
const transport = new StdioServerTransport();
await server.connect(transport);
