import { useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export function TagInput({
  value,
  onChange,
  placeholder = "Type and press Enter",
  id,
}: {
  value: string[] | undefined | null;
  onChange: (v: string[]) => void;
  placeholder?: string;
  id?: string;
}) {
  const tags = Array.isArray(value) ? value : [];
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...tags, ...parts.filter((p) => !tags.includes(p))]);
    setDraft("");
  };
  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1 pr-1 font-normal">
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                className="rounded-sm p-0.5 hover:bg-background focus-visible:ring-2 focus-visible:ring-ring outline-none"
                onClick={() => onChange(tags.filter((x) => x !== t))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        id={id}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}
