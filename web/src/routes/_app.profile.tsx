import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Controller, useFieldArray, useForm, type UseFormReturn } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Loader2, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { TagInput } from "@/components/tag-input";
import { api } from "@/lib/api";
import { useMe } from "@/hooks/use-me";

export const Route = createFileRoute("/_app/profile")({
  head: () => ({ meta: [{ title: "Profile & Resume — Job Autopilot" }] }),
  component: ProfilePage,
});

const num = (v: any) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));

function normalize(p: any) {
  const profile = p ?? {};
  return {
    ...profile,
    personal: { ...(profile.personal ?? {}) },
    preferences: { ethnicity: "Prefer not to say", ...(profile.preferences ?? {}) },
    skills: Array.isArray(profile.skills) ? profile.skills : [],
    experience: Array.isArray(profile.experience) ? profile.experience : [],
    education: Array.isArray(profile.education) ? profile.education : [],
    certifications: Array.isArray(profile.certifications) ? profile.certifications : [],
    languages: Array.isArray(profile.languages) ? profile.languages : [],
  };
}

function F({ label, id, children, className }: { label: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ProfilePage() {
  const me = useMe();
  const qc = useQueryClient();
  const form = useForm<any>({ defaultValues: normalize(null) });
  const original = useRef<any>(null);

  useEffect(() => {
    if (me.data) {
      original.current = me.data.profile ?? {};
      form.reset(normalize(me.data.profile));
    }
  }, [me.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (v: any) => {
      const o = original.current ?? {};
      const profile = {
        ...o,
        ...v,
        personal: { ...(o.personal ?? {}), ...v.personal },
        preferences: { ...(o.preferences ?? {}), ...v.preferences },
      };
      return api("/api/profile", { method: "PUT", json: { profile } }).then(() => profile);
    },
    onSuccess: (profile) => {
      toast.success("Profile saved");
      original.current = profile;
      form.reset(normalize(profile));
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });

  if (me.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
      </div>
    );
  }

  const r = form.register;
  return (
    <div className="space-y-6 pb-20">
      <PageHeader title="Profile & Resume" description="Everything the bot uses to fill in applications." />
      <ResumeCard resume={me.data?.resume ?? null} onParsed={(profile) => { original.current = profile; form.reset(normalize(profile)); }} />

      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-6">
        <Section title="Personal details">
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["first_name", "First name"], ["last_name", "Last name"], ["email", "Email"], ["phone", "Phone"],
              ["city", "City"], ["state", "State / region"], ["country", "Country"], ["postal_code", "Postal code"],
              ["linkedin_url", "LinkedIn URL"], ["github_url", "GitHub URL"], ["portfolio_url", "Portfolio URL"],
            ].map(([k, l]) => k && l && (
              <F key={k} id={`p-${k}`} label={l}>
                <Input id={`p-${k}`} {...r(`personal.${k}`)} />
              </F>
            ))}
          </div>
        </Section>

        <Section title="Career">
          <div className="grid gap-4 sm:grid-cols-2">
            <F id="headline" label="Headline" className="sm:col-span-2"><Input id="headline" {...r("headline")} /></F>
            <F id="current_title" label="Current title"><Input id="current_title" {...r("current_title")} /></F>
            <F id="current_company" label="Current company"><Input id="current_company" {...r("current_company")} /></F>
            <F id="yoe" label="Total years of experience"><Input id="yoe" type="number" step="0.5" min={0} {...r("total_years_experience", { setValueAs: num })} /></F>
            <F id="summary" label="Summary" className="sm:col-span-2"><Textarea id="summary" rows={5} {...r("summary")} /></F>
          </div>
        </Section>

        <SkillsSection form={form} />

        <ListSection
          form={form}
          name="experience"
          title="Experience"
          empty={{ title: "", company: "", location: "", start_date: "", end_date: "", is_current: false, highlights: [] }}
          summary={(e) => [e.title || "Untitled role", [e.company, e.location].filter(Boolean).join(" · "), `${e.start_date || "?"} – ${e.is_current ? "Present" : e.end_date || "?"}`]}
          fields={[
            { k: "title", l: "Title" }, { k: "company", l: "Company" }, { k: "location", l: "Location" },
            { k: "start_date", l: "Start date" }, { k: "end_date", l: "End date" },
            { k: "is_current", l: "I currently work here", type: "bool" },
            { k: "highlights", l: "Highlights (one per line)", type: "lines" },
          ]}
        />
        <ListSection
          form={form}
          name="education"
          title="Education"
          empty={{ degree: "", field_of_study: "", school: "", start_year: "", end_year: "", grade: "" }}
          summary={(e) => [[e.degree, e.field_of_study].filter(Boolean).join(", ") || "Education", e.school, `${e.start_year || ""}${e.end_year ? ` – ${e.end_year}` : ""}${e.grade ? ` · ${e.grade}` : ""}`]}
          fields={[
            { k: "degree", l: "Degree" }, { k: "field_of_study", l: "Field of study" }, { k: "school", l: "School" },
            { k: "start_year", l: "Start year" }, { k: "end_year", l: "End year" }, { k: "grade", l: "Grade" },
          ]}
        />

        <Section title="Certifications & languages">
          <div className="space-y-6">
            <F id="certs" label="Certifications">
              <Controller control={form.control} name="certifications" render={({ field }) => <TagInput id="certs" value={field.value} onChange={field.onChange} />} />
            </F>
            <LanguagesEditor form={form} />
          </div>
        </Section>

        <Section
          title="Application answers"
          description="The bot answers these questions from what you set here. Salary, date of birth, address and EEO answers are never guessed by the AI."
        >
          <PreferencesFields form={form} />
        </Section>

        {form.formState.isDirty && (
          <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-xl border bg-card p-3 shadow-lg">
            <span className="text-sm text-muted-foreground">You have unsaved changes</span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => form.reset()}>Discard</Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />} Save profile
              </Button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

function ResumeCard({ resume, onParsed }: { resume: { filename: string; updated_at: string } | null; onParsed: (p: any) => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (f?: File | null) => {
    if (!f) return undefined;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) { toast.error("Please choose a PDF file"); return undefined; }
    if (f.size > 5 * 1024 * 1024) { toast.error("The file is larger than 5 MB"); return undefined; }
    setFile(f); return undefined;
  };

  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append("resume", file!);
      return api<{ profile: any; resume: any }>("/api/resume", { method: "POST", body: fd });
    },
    onSuccess: (d) => {
      toast.success("Resume parsed — review your profile below");
      setFile(null);
      onParsed(d.profile);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });

  return (
    <Section title="Resume" description={resume ? `Current: ${resume.filename} · updated ${new Date(resume.updated_at).toLocaleDateString()}` : "No resume uploaded yet."}>
      {upload.isPending ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed p-6 text-sm">
          <Loader2 className="size-5 animate-spin text-primary" />
          Reading your resume with AI… this takes 10–30 seconds.
        </div>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
            className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${drag ? "border-primary bg-accent" : "hover:bg-muted/50"}`}
          >
            {file ? <FileText className="size-6 text-primary" /> : <Upload className="size-6 text-muted-foreground" />}
            <span className="font-medium">{file ? file.name : "Drop a PDF here or click to choose"}</span>
            <span className="text-xs text-muted-foreground">PDF, up to 5 MB</span>
          </button>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          <div className="flex justify-end">
            <Button type="button" disabled={!file} onClick={() => upload.mutate()}>
              <Upload /> Upload & parse
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function SkillsSection({ form }: { form: UseFormReturn<any> }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "skills" });
  const [name, setName] = useState("");
  return (
    <Section title="Skills">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {fields.length === 0 && <p className="text-sm text-muted-foreground">No skills yet.</p>}
          {fields.map((f, i) => (
            <div key={f.id} className="flex items-center gap-1 rounded-lg border bg-muted/40 py-1 pl-3 pr-1">
              <input aria-label="Skill" className="w-28 bg-transparent text-sm outline-none" {...form.register(`skills.${i}.name`)} />
              <input aria-label="Years" type="number" min={0} step="0.5" className="w-12 rounded bg-background px-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" {...form.register(`skills.${i}.years`, { setValueAs: num })} />
              <span className="text-xs text-muted-foreground">yrs</span>
              <Button type="button" size="icon" variant="ghost" className="size-6" aria-label="Remove skill" onClick={() => remove(i)}>
                <X className="size-3" />
              </Button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="Add a skill"
            aria-label="New skill"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (name.trim()) { append({ name: name.trim(), years: null }); setName(""); }
              }
            }}
          />
          <Button type="button" variant="outline" onClick={() => { if (name.trim()) { append({ name: name.trim(), years: null }); setName(""); } }}>
            <Plus /> Add
          </Button>
        </div>
      </div>
    </Section>
  );
}

type FieldDef = { k: string; l: string; type?: "bool" | "lines" };

function ListSection({ form, name, title, empty, fields, summary }: {
  form: UseFormReturn<any>; name: string; title: string; empty: any; fields: FieldDef[]; summary: (e: any) => string[];
}) {
  const items: any[] = form.watch(name) ?? [];
  const [edit, setEdit] = useState<{ index: number; value: any } | null>(null);

  const commit = () => {
    if (!edit) return;
    const next = [...items];
    if (edit.index < 0) next.push(edit.value);
    else next[edit.index] = edit.value;
    form.setValue(name, next, { shouldDirty: true });
    setEdit(null);
  };

  return (
    <Section title={title}>
      <div className="space-y-2">
        {items.length === 0 && <p className="text-sm text-muted-foreground">Nothing added yet.</p>}
        {items.map((e, i) => {
          const [a, b, c] = summary(e);
          return (
            <div key={i} className="flex items-start gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{a}</p>
                {b && <p className="text-sm text-muted-foreground">{b}</p>}
                {c && <p className="text-xs text-muted-foreground">{c}</p>}
              </div>
              <Button type="button" size="icon" variant="ghost" aria-label="Edit" onClick={() => setEdit({ index: i, value: { ...e } })}><Pencil /></Button>
              <Button type="button" size="icon" variant="ghost" aria-label="Remove" onClick={() => form.setValue(name, items.filter((_, j) => j !== i), { shouldDirty: true })}><Trash2 /></Button>
            </div>
          );
        })}
        <Button type="button" variant="outline" onClick={() => setEdit({ index: -1, value: { ...empty } })}><Plus /> Add</Button>
      </div>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{edit?.index === -1 ? "Add" : "Edit"} {title.toLowerCase()}</DialogTitle></DialogHeader>
          {edit && (
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((f) => {
                const id = `${name}-${f.k}`;
                const v = edit.value[f.k];
                const set = (val: any) => setEdit({ ...edit, value: { ...edit.value, [f.k]: val } });
                if (f.type === "bool")
                  return (
                    <div key={f.k} className="flex items-center gap-2 sm:col-span-2">
                      <Checkbox id={id} checked={!!v} onCheckedChange={(c) => set(!!c)} />
                      <Label htmlFor={id} className="font-normal">{f.l}</Label>
                    </div>
                  );
                if (f.type === "lines")
                  return (
                    <F key={f.k} id={id} label={f.l} className="sm:col-span-2">
                      <Textarea id={id} rows={5} value={Array.isArray(v) ? v.join("\n") : v ?? ""} onChange={(e) => set(e.target.value.split("\n"))} />
                    </F>
                  );
                return (
                  <F key={f.k} id={id} label={f.l}>
                    <Input id={id} value={v ?? ""} onChange={(e) => set(e.target.value)} />
                  </F>
                );
              })}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => {
                if (edit && Array.isArray(edit.value.highlights)) edit.value.highlights = edit.value.highlights.map((s: string) => s.trim()).filter(Boolean);
                commit();
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function LanguagesEditor({ form }: { form: UseFormReturn<any> }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "languages" });
  return (
    <div className="space-y-2">
      <Label>Languages</Label>
      {fields.map((f, i) => (
        <div key={f.id} className="flex gap-2">
          <Input aria-label="Language" placeholder="Language" {...form.register(`languages.${i}.language`)} />
          <Input aria-label="Proficiency" placeholder="Proficiency" {...form.register(`languages.${i}.proficiency`)} />
          <Button type="button" size="icon" variant="ghost" aria-label="Remove language" onClick={() => remove(i)}><Trash2 /></Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => append({ language: "", proficiency: "" })}><Plus /> Add language</Button>
    </div>
  );
}

const SELECTS: Record<string, string[]> = {
  gender: ["Prefer not to say", "Female", "Male", "Non-binary"],
  veteran_status: ["Prefer not to say", "I am not a protected veteran", "I am a protected veteran"],
  disability_status: ["Prefer not to say", "No, I do not have a disability", "Yes, I have a disability"],
};

function PreferencesFields({ form }: { form: UseFormReturn<any> }) {
  const r = form.register;
  const p = (k: string) => `preferences.${k}`;
  const sw = (k: string, l: string) => (
    <div key={k} className="flex items-center justify-between gap-4 p-3">
      <Label htmlFor={k} className="font-normal">{l}</Label>
      <Controller control={form.control} name={p(k)} render={({ field }) => <Switch id={k} checked={!!field.value} onCheckedChange={field.onChange} />} />
    </div>
  );
  const sel = (k: string, l: string) => (
    <F key={k} id={k} label={l}>
      <Controller
        control={form.control}
        name={p(k)}
        render={({ field }) => (
          <Select value={field.value || undefined} onValueChange={field.onChange}>
            <SelectTrigger id={k}><SelectValue placeholder="Choose…" /></SelectTrigger>
            <SelectContent>{(SELECTS[k] ?? []).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
          </Select>
        )}
      />
    </F>
  );
  const txt = (k: string, l: string, type = "text") => (
    <F key={k} id={k} label={l}>
      <Input id={k} type={type} {...r(p(k), type === "number" ? { setValueAs: num } : {})} />
    </F>
  );
  return (
    <div className="space-y-6">
      <div className="divide-y rounded-lg border">
        {sw("authorized_to_work", "Authorized to work")}
        {sw("requires_sponsorship", "Requires visa sponsorship")}
        {sw("willing_to_relocate", "Willing to relocate")}
        {sw("willing_to_work_onsite", "Willing to work on-site")}
        {sw("has_drivers_license", "Has a driver's license")}
        {sw("background_check_ok", "OK with a background check")}
      </div>
      <F id="authorized_countries" label="Authorized to work in (countries)">
        <Controller control={form.control} name={p("authorized_countries")} render={({ field }) => <TagInput id="authorized_countries" value={field.value} onChange={field.onChange} />} />
      </F>
      <div className="grid gap-4 sm:grid-cols-2">
        {txt("notice_period", "Notice period")}
        {txt("notice_period_days", "Notice period (days)", "number")}
        {txt("earliest_start_date", "Earliest start date", "date")}
        {txt("expected_salary", "Expected salary")}
        {txt("current_salary", "Current salary")}
        {txt("salary_currency", "Salary currency")}
        {txt("phone_country_code", "Phone country code")}
        {txt("date_of_birth", "Date of birth", "date")}
        <F id="address" label="Address" className="sm:col-span-2"><Input id="address" {...r(p("address"))} /></F>
        {txt("referral_source", "How did you hear about us (default)")}
        {txt("pronouns", "Pronouns")}
        {sel("gender", "Gender")}
        {txt("ethnicity", "Ethnicity")}
        {sel("veteran_status", "Veteran status")}
        {sel("disability_status", "Disability status")}
      </div>
    </div>
  );
}
