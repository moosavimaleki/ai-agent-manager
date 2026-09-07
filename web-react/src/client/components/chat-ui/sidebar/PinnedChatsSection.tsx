import { memo, type ReactNode } from "react"
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
import { Button } from "../../ui/button"
import { cn } from "../../../lib/utils"
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
  renderChatRow,
  onUnpin,
}: {
  chat: SidebarChatRow
  renderChatRow: (chat: SidebarChatRow) => ReactNode
  onUnpin: (chat: SidebarChatRow) => void
}) {
  const { locale } = useI18n()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: chat.chatId })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("flex min-w-0 items-center gap-0.5", isDragging && "relative z-20 opacity-70")}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={locale === "fa" ? `جابجایی ${chat.title}` : `Reorder ${chat.title}`}
        title={locale === "fa" ? "جابجایی سنجاق" : "Reorder pin"}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">{renderChatRow(chat)}</div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
        aria-label={locale === "fa" ? `برداشتن سنجاق ${chat.title}` : `Unpin ${chat.title}`}
        title={locale === "fa" ? "برداشتن سنجاق" : "Unpin"}
        onClick={(event) => {
          event.stopPropagation()
          onUnpin(chat)
        }}
      >
        <PinOff className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

export const PinnedChatsSection = memo(function PinnedChatsSection({
  chats,
  renderChatRow,
  onUnpin,
  onReorder,
  orderedChatIds,
}: {
  chats: SidebarChatRow[]
  renderChatRow: (chat: SidebarChatRow) => ReactNode
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
      <div className="flex h-7 items-center gap-1.5 px-2 text-[10px] font-medium text-muted-foreground/80">
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
                renderChatRow={renderChatRow}
                onUnpin={onUnpin}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  )
})
