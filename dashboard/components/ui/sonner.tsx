"use client"

import { Toaster as SonnerToaster } from "sonner"

function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "bg-background text-foreground border shadow-lg",
          description: "text-muted-foreground",
        },
      }}
    />
  )
}

export { Toaster }
