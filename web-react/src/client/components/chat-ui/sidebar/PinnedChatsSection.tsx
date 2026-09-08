import { memo } from "react"
import { GripVertical, Pin, PinOff } from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { SidebarChatRow } from "../../../../shared/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu"
import { formatSidebarAgeLabel } from "../../../lib/formatters"
import { getSidebarChatTimestamp } from "../../../lib/sidebarChats"
import { cn, normalizeChatId } from "../../../lib/utils"
import { useI18n } from "../../../i18n/context"

export function getPinnedChatsInUserOrder(chats: SidebarChatRow[], preferredOrder: string[] = []) {
  const pinned = chats
    .filter((chat) => chat.pinned)
    .slice()
    .sort((left, right) => {
      const leftOrder = left.pinnedOrder ?? left._creationTime
      const rightOrder = right.pinnedOrder ?? right._creationTime
      if (leftOrder !== rightOrder) return rightOrder - leftOrder
      return left.chatId.localeCompare(right.chatId)
    })
  if (preferredOrder.length === 0) return pinned
  const byID = new Map(pinned.map((chat) => [chat.chatId, chat]))
  const preferred = preferredOrder.flatMap((chatID) => {
    const chat = byID.get(chatID)
    if (!chat) return []
    byID.delete(chatID)
    return [chat]
  })
  return [...preferred, ...byID.values()]
}

function SortablePinnedChat({
  chat,
  activeChatId,
  nowMs,
  onSelectChat,
  onUnpin,
}: {
  chat: SidebarChatRow
  activeChatId: string | null
  nowMs: number
  onSelectChat: (chatId: string) => void
  onUnpin: (chat: SidebarChatRow) => void
}) {
  const { direction, locale, t } = useI18n()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: chat.chatId })
  const normalizedChatId = normalizeChatId(chat.chatId)
  const ageLabel = formatSidebarAgeLabel(getSidebarChatTimestamp(chat), nowMs)
  const isActive = activeChatId === normalizedChatId

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={{ transform: CSS.Transform.toString(transform), transition }}
          dir={direction}
          className={cn(
            "group flex min-w-0 items-center gap-1 rounded-lg border px-2 py-1 transition-colors",
            isActive
              ? "border-border bg-muted text-foreground"
              : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-muted/20 hover:text-foreground",
            isDragging && "relative z-20 opacity-70 shadow-md",
          )}
        >
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground active:cursor-grabbing focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
            aria-label={locale === "fa" ? `جابجایی ${chat.title}` : `Reorder ${chat.title}`}
            title={locale === "fa" ? "جابجایی سنجاق" : "Reorder pin"}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-chat-id={normalizedChatId}
            className="min-w-0 flex-1 truncate text-start text-sm leading-6 outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            title={chat.title}
            onClick={() => onSelectChat(chat.chatId)}
          >
            <span dir="auto">{locale === "fa" && chat.title === "New Chat" ? t.sidebar.newChat : chat.title}</span>
          </button>
          {ageLabel ? (
            <span
              dir="ltr"
              className="pointer-events-none shrink-0 text-[10px] tabular-nums text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              aria-label={locale === "fa" ? `آخرین فعالیت ${ageLabel}` : `Last activity ${ageLabel}`}
            >
              {ageLabel}
            </span>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent dir={direction} className="min-w-40">
        <ContextMenuItem onSelect={() => onUnpin(chat)}>
          <PinOff className="size-3.5" aria-hidden="true" />
          <span>{locale === "fa" ? "برداشتن سنجاق" : "Unpin"}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export const PinnedChatsSection = memo(function PinnedChatsSection({
  chats,
  activeChatId,
  nowMs,
  onSelectChat,
  onUnpin,
  onReorder,
  orderedChatIds,
}: {
  chats: SidebarChatRow[]
  activeChatId: string | null
  nowMs: number
  onSelectChat: (chatId: string) => void
  onUnpin: (chat: SidebarChatRow) => void
  onReorder: (chatIds: string[]) => void
  orderedChatIds?: string[]
}) {
  const { locale } = useI18n()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )
  const pinnedChats = getPinnedChatsInUserOrder(chats, orderedChatIds)

  if (pinnedChats.length === 0) return null

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = pinnedChats.findIndex((chat) => chat.chatId === active.id)
    const newIndex = pinnedChats.findIndex((chat) => chat.chatId === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    onReorder(arrayMove(pinnedChats, oldIndex, newIndex).map((chat) => chat.chatId))
  }

  return (
    <section className="mb-2 space-y-1 px-1" aria-label={locale === "fa" ? "چت‌های سنجاق‌شده" : "Pinned chats"}>
      <div className="flex h-6 items-center gap-1.5 px-2 text-[10px] font-medium text-muted-foreground/80">
        <Pin className="size-3" aria-hidden="true" />
        <span>{locale === "fa" ? "سنجاق‌شده‌ها" : "Pinned"}</span>
        <span className="tabular-nums text-muted-foreground/55">{pinnedChats.length}</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={pinnedChats.map((chat) => chat.chatId)} strategy={verticalListSortingStrategy}>
          <div className="space-y-0.5">
            {pinnedChats.map((chat) => (
              <SortablePinnedChat
                key={chat.chatId}
                chat={chat}
                activeChatId={activeChatId}
                nowMs={nowMs}
                onSelectChat={onSelectChat}
                onUnpin={onUnpin}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  )
})
