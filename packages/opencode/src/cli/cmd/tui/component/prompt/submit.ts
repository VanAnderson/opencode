import type { CommandInput, PromptInput } from "@/session/prompt-input"

export type BusySubmitMode = "queue" | "steer"
export type EditingPendingMessage = {
  pendingMessageID: string
  mode: BusySubmitMode
}

type ModelRef = {
  providerID: string
  modelID: string
}

type SubmitStatus = {
  type: string
}

type PromptRequest = {
  kind: "prompt"
  sessionID: string
  agent: string
  model: ModelRef
  variant?: string
  messageID: string
  parts: PromptInput["parts"]
}

type CommandRequest = {
  kind: "command"
  sessionID: string
  command: string
  arguments: string
  agent: string
  model: string
  variant?: string
  messageID: string
  parts?: CommandInput["parts"]
}

type ShellRequest = {
  kind: "shell"
  sessionID: string
  agent: string
  model: ModelRef
  command: string
}

type TuiSubmitRequest = PromptRequest | CommandRequest | ShellRequest

type SessionClient = {
  session: {
    prompt(input: Omit<PromptRequest, "kind">): Promise<unknown>
    command(input: Omit<CommandRequest, "kind">): Promise<unknown>
    shell(input: Omit<ShellRequest, "kind">): Promise<unknown>
    queueUpdate(input: {
      sessionID: string
      pendingMessageID: string
      mode?: BusySubmitMode
      payload?:
        | {
            kind: "prompt"
            agent: string
            model: ModelRef
            variant?: string
            parts: PromptInput["parts"]
          }
        | {
            kind: "command"
            command: string
            arguments: string
            agent: string
            model: string
            variant?: string
            parts?: CommandInput["parts"]
          }
    }): Promise<unknown>
    submit(input: {
      sessionID: string
      mode?: BusySubmitMode
      source?: string
      payload:
        | {
            kind: "prompt"
            agent: string
            model: ModelRef
            variant?: string
            parts: PromptInput["parts"]
          }
        | {
            kind: "command"
            command: string
            arguments: string
            agent: string
            model: string
            variant?: string
            parts?: CommandInput["parts"]
          }
    }): Promise<unknown>
  }
}

export function usesQueuedSubmit(input: {
  status: SubmitStatus
  request: TuiSubmitRequest
}) {
  return input.request.kind !== "shell" && input.status.type !== "idle"
}

export async function dispatchPromptSubmit(input: {
  client: SessionClient
  status: SubmitStatus
  request: TuiSubmitRequest
  requestedMode?: BusySubmitMode
  editingPendingMessage?: EditingPendingMessage
}) {
  const request = input.request

  if (request.kind === "shell") {
    return input.client.session.shell({
      sessionID: request.sessionID,
      agent: request.agent,
      model: request.model,
      command: request.command,
    })
  }

  if (input.editingPendingMessage) {
    if (request.kind === "command") {
      return input.client.session.queueUpdate({
        sessionID: request.sessionID,
        pendingMessageID: input.editingPendingMessage.pendingMessageID,
        payload: {
          kind: "command",
          command: request.command,
          arguments: request.arguments,
          agent: request.agent,
          model: request.model,
          variant: request.variant,
          parts: request.parts,
        },
      })
    }

    return input.client.session.queueUpdate({
      sessionID: request.sessionID,
      pendingMessageID: input.editingPendingMessage.pendingMessageID,
      payload: {
        kind: "prompt",
        agent: request.agent,
        model: request.model,
        variant: request.variant,
        parts: request.parts,
      },
    })
  }

  if (usesQueuedSubmit(input)) {
    if (request.kind === "command") {
      return input.client.session.submit({
        sessionID: request.sessionID,
        mode: input.requestedMode ?? "queue",
        source: "tui",
        payload: {
          kind: "command",
          command: request.command,
          arguments: request.arguments,
          agent: request.agent,
          model: request.model,
          variant: request.variant,
          parts: request.parts,
        },
      })
    }

    return input.client.session.submit({
      sessionID: request.sessionID,
      mode: input.requestedMode ?? "queue",
      source: "tui",
      payload: {
        kind: "prompt",
        agent: request.agent,
        model: request.model,
        variant: request.variant,
        parts: request.parts,
      },
    })
  }

  if (request.kind === "command") {
    return input.client.session.command({
      sessionID: request.sessionID,
      command: request.command,
      arguments: request.arguments,
      agent: request.agent,
      model: request.model,
      messageID: request.messageID,
      variant: request.variant,
      parts: request.parts,
    })
  }

  return input.client.session.prompt({
    sessionID: request.sessionID,
    agent: request.agent,
    model: request.model,
    messageID: request.messageID,
    variant: request.variant,
    parts: request.parts,
  })
}
