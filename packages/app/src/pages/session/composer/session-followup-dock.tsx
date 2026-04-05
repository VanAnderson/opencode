import { For, Show, createMemo, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function SessionFollowupDock(props: {
  items: {
    id: string
    text: string
    meta?: string
    status?: string
    resume?: boolean
    sendLabel?: string
    sendDisabled?: boolean
    resumeDisabled?: boolean
    editDisabled?: boolean
    deleteDisabled?: boolean
    moveUpDisabled?: boolean
    moveDownDisabled?: boolean
  }[]
  sending?: string
  clearing?: boolean
  clearDisabled?: boolean
  onSend?: (id: string) => void
  onResume?: (id: string) => void
  onEdit?: (id: string) => void
  onDelete?: (id: string) => void
  onMoveUp?: (id: string) => void
  onMoveDown?: (id: string) => void
  onClear?: () => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: false,
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const holdButton: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> = (event) => {
    event.preventDefault()
    event.stopPropagation()
  }
  const clearQueue: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> = (event) => {
    event.stopPropagation()
    props.onClear?.()
  }
  const total = createMemo(() => props.items.length)
  const label = createMemo(() =>
    language.t(total() === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <DockTray
      data-component="session-followup-dock"
      style={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <div
        class="pl-3 pr-2 py-2 flex items-center gap-2"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggle()
        }}
      >
        <span class="shrink-0 text-13-medium text-text-strong cursor-default">{label()}</span>
        <Show when={store.collapsed && preview()}>
          <span class="min-w-0 flex-1 truncate text-13-regular text-text-base cursor-default">{preview()}</span>
        </Show>
        <div class="ml-auto shrink-0 flex items-center gap-1">
          <Show when={props.onClear}>
            <Button
              size="small"
              variant="ghost"
              disabled={!!props.sending || props.clearing || props.clearDisabled}
              onMouseDown={holdButton}
              onClick={clearQueue}
            >
              {language.t("session.followupDock.clearAll")}
            </Button>
          </Show>
          <IconButton
            data-collapsed={store.collapsed ? "true" : "false"}
            icon="chevron-down"
            size="normal"
            variant="ghost"
            style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            aria-label={
              store.collapsed ? language.t("session.followupDock.expand") : language.t("session.followupDock.collapse")
            }
          />
        </div>
      </div>

      <Show when={store.collapsed}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={!store.collapsed}>
        <div class="px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <div class="flex items-start gap-2 min-w-0 py-1">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{item.text}</span>
                    <Show when={item.status}>
                      <span class="shrink-0 rounded-full bg-background-panel px-2 py-0.5 text-11-medium text-text-weak">
                        {item.status}
                      </span>
                    </Show>
                  </div>
                  <Show when={item.meta}>
                    <div class="truncate text-11-regular text-text-weak">{item.meta}</div>
                  </Show>
                </div>
                <div class="shrink-0 flex items-center gap-1">
                  <Show when={props.onMoveUp}>
                    <IconButton
                      icon="arrow-up"
                      size="small"
                      variant="ghost"
                      disabled={!!props.sending || props.clearing || item.moveUpDisabled}
                      onClick={() => props.onMoveUp?.(item.id)}
                      aria-label={language.t("session.followupDock.moveUp")}
                    />
                  </Show>
                  <Show when={props.onMoveDown}>
                    <IconButton
                      icon="arrow-up"
                      size="small"
                      variant="ghost"
                      style={{ transform: "rotate(180deg)" }}
                      disabled={!!props.sending || props.clearing || item.moveDownDisabled}
                      onClick={() => props.onMoveDown?.(item.id)}
                      aria-label={language.t("session.followupDock.moveDown")}
                    />
                  </Show>
                  <Show when={item.resume && props.onResume}>
                    <Button
                      size="small"
                      variant="ghost"
                      class="shrink-0"
                      disabled={!!props.sending || props.clearing || item.resumeDisabled}
                      onClick={() => props.onResume?.(item.id)}
                    >
                      {language.t("session.followupDock.resume")}
                    </Button>
                  </Show>
                  <Button
                    size="small"
                    variant="secondary"
                    class="shrink-0"
                    disabled={!!props.sending || props.clearing || !props.onSend || item.sendDisabled}
                    onClick={() => props.onSend?.(item.id)}
                  >
                    {item.sendLabel ?? language.t("session.followupDock.sendNow")}
                  </Button>
                  <Show when={props.onEdit}>
                    <Button
                      size="small"
                      variant="ghost"
                      class="shrink-0"
                      disabled={!!props.sending || props.clearing || item.editDisabled}
                      onClick={() => props.onEdit?.(item.id)}
                    >
                      {language.t("session.followupDock.edit")}
                    </Button>
                  </Show>
                  <Show when={props.onDelete}>
                    <Button
                      size="small"
                      variant="ghost"
                      class="shrink-0"
                      disabled={!!props.sending || props.clearing || item.deleteDisabled}
                      onClick={() => props.onDelete?.(item.id)}
                    >
                      {language.t("common.delete")}
                    </Button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </DockTray>
  )
}
