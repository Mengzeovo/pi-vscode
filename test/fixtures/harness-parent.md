---
name: harness-parent
description: 使用 worker 完成所属目录的文件任务
tools: subagent, read, write, bash
allowNestedSubagents: true
allowedAgents: worker
maxSubagentDepth: 3
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
defaultReads: false
defaultProgress: false
---

接收到任务后，通过 subagent 工具委派 worker，保持提供的工作目录、模型和文件内容。等待 worker 完成并报告结果。文件操作由 worker 完成。
