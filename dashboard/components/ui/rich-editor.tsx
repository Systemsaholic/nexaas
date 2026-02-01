"use client"

import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import Link from "@tiptap/extension-link"
import Image from "@tiptap/extension-image"
import TextAlign from "@tiptap/extension-text-align"
import { useCallback } from "react"
import { cn } from "@/lib/utils"
import {
  BoldIcon,
  ItalicIcon,
  StrikethroughIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  LinkIcon,
  ImageIcon,
  AlignLeftIcon,
  AlignCenterIcon,
  AlignRightIcon,
  Undo2Icon,
  Redo2Icon,
  SparklesIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"

interface RichEditorProps {
  content?: string
  onChange?: (html: string) => void
  placeholder?: string
  onAiImprove?: (content: string) => void
  aiLoading?: boolean
  className?: string
  editable?: boolean
}

function ToolbarButton({
  active,
  onClick,
  children,
  title,
  disabled,
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  title: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "rounded p-1.5 transition-colors hover:bg-muted disabled:opacity-50",
        active && "bg-muted text-primary"
      )}
    >
      {children}
    </button>
  )
}

export function RichEditor({
  content = "",
  onChange,
  placeholder = "Start writing...",
  onAiImprove,
  aiLoading,
  className,
  editable = true,
}: RichEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      Link.configure({ openOnClick: false }),
      Image,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
    ],
    content,
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      onChange?.(editor.getHTML())
    },
  })

  const addLink = useCallback(() => {
    if (!editor) return
    const url = window.prompt("URL:")
    if (url) {
      editor.chain().focus().setLink({ href: url }).run()
    }
  }, [editor])

  const addImage = useCallback(() => {
    if (!editor) return
    const url = window.prompt("Image URL:")
    if (url) {
      editor.chain().focus().setImage({ src: url }).run()
    }
  }, [editor])

  if (!editor) return null

  const iconSize = "size-4"

  return (
    <div className={cn("rounded-md border", className)}>
      {editable && (
        <div className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1.5">
          <ToolbarButton active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
            <BoldIcon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
            <ItalicIcon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
            <StrikethroughIcon className={iconSize} />
          </ToolbarButton>

          <div className="mx-1 h-5 w-px bg-border" />

          <ToolbarButton active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1">
            <Heading1Icon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">
            <Heading2Icon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">
            <Heading3Icon className={iconSize} />
          </ToolbarButton>

          <div className="mx-1 h-5 w-px bg-border" />

          <ToolbarButton active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
            <ListIcon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered list">
            <ListOrderedIcon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Blockquote">
            <QuoteIcon className={iconSize} />
          </ToolbarButton>

          <div className="mx-1 h-5 w-px bg-border" />

          <ToolbarButton onClick={addLink} active={editor.isActive("link")} title="Insert link">
            <LinkIcon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton onClick={addImage} title="Insert image">
            <ImageIcon className={iconSize} />
          </ToolbarButton>

          <div className="mx-1 h-5 w-px bg-border" />

          <ToolbarButton active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()} title="Align left">
            <AlignLeftIcon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()} title="Align center">
            <AlignCenterIcon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()} title="Align right">
            <AlignRightIcon className={iconSize} />
          </ToolbarButton>

          <div className="mx-1 h-5 w-px bg-border" />

          <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="Undo">
            <Undo2Icon className={iconSize} />
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="Redo">
            <Redo2Icon className={iconSize} />
          </ToolbarButton>

          {onAiImprove && (
            <>
              <div className="mx-1 h-5 w-px bg-border" />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-purple-600 hover:text-purple-700"
                disabled={aiLoading}
                onClick={() => onAiImprove(editor.getHTML())}
              >
                <SparklesIcon className="size-3.5" />
                {aiLoading ? "Rewriting..." : "Ask AI to Improve"}
              </Button>
            </>
          )}
        </div>
      )}
      <EditorContent
        editor={editor}
        className={cn(
          "prose prose-sm dark:prose-invert max-w-none px-4 py-3 focus-within:outline-none [&_.tiptap]:outline-none [&_.tiptap]:min-h-[120px]",
          !editable && "cursor-default"
        )}
      />
    </div>
  )
}

export function useRichEditorContent(editor: ReturnType<typeof useEditor>) {
  return {
    getHTML: () => editor?.getHTML() ?? "",
    setContent: (html: string) => editor?.commands.setContent(html),
  }
}
