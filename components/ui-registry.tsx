"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleHelp,
  Info,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AppShell, Board, BoardColumn, ConfirmDialog, DetailPanel, DetailPanelSection, EmptyState, EntityCard, FilterBar, FormField, LoadingState, MetricBadge, PageHeader, PageSection, SettingsSection, StatusBadge, Toolbar } from "@/components/patterns";

const surfaceTokens = [
  ["App", "bg-surface-app"], ["Navigation", "bg-surface-navigation"],
  ["Navigation active", "bg-surface-navigation-active"], ["Panel", "bg-surface-panel"],
  ["Card", "bg-surface-card"], ["Inset", "bg-surface-inset"],
  ["Interactive", "bg-surface-interactive"], ["Interactive hover", "bg-surface-interactive-hover"],
] as const;

const statuses = [
  ["Neutral", "bg-status-neutral-surface text-status-neutral", CircleHelp],
  ["Info", "bg-status-info-surface text-status-info", Info],
  ["Success", "bg-status-success-surface text-status-success", Check],
  ["Warning", "bg-status-warning-surface text-status-warning", AlertTriangle],
  ["Danger", "bg-status-danger-surface text-status-danger", AlertTriangle],
] as const;

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 border-t border-border-default pt-10">
      <div className="mb-6 max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight text-text-primary">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-text-subtle">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Example({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border-default bg-surface-panel p-5 shadow-[var(--shadow-card)] ${className}`}>
      <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-text-subtle">{title}</h3>
      {children}
    </div>
  );
}

export function UIRegistry() {
  return (
    <TooltipProvider>
      <main className="min-h-screen bg-surface-app px-[var(--space-page-x)] py-[var(--space-page-y)]">
        <div className="mx-auto max-w-6xl">
          <header className="grid gap-6 pb-10 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <Badge variant="secondary">Compass design system</Badge>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-text-primary">UI registry</h1>
              <p className="mt-3 max-w-2xl text-base leading-7 text-text-secondary">A repository-native reference for semantic tokens, typography, controls, interaction states, and responsive behavior.</p>
            </div>
            <nav aria-label="Registry sections" className="flex flex-wrap gap-2 text-sm">
              {[["Tokens", "tokens"], ["Type", "typography"], ["Controls", "controls"], ["Patterns", "patterns"], ["Overlays", "overlays"], ["Responsive", "responsive"]].map(([label, id]) => <a key={id} className="rounded-lg px-2.5 py-1.5 text-text-subtle hover:bg-surface-interactive hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus" href={`#${id}`}>{label}</a>)}
            </nav>
          </header>

          <div className="space-y-12">
            <Section id="tokens" title="Semantic tokens" description="Product code should choose a role from this vocabulary instead of a literal palette value.">
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {surfaceTokens.map(([name, className]) => <div key={name} className="overflow-hidden rounded-xl border border-border-default bg-surface-panel"><div className={`h-20 ${className}`} /><div className="p-3"><div className="text-sm font-medium">{name}</div><code className="text-xs text-text-subtle">surface-{name.toLowerCase().replaceAll(" ", "-")}</code></div></div>)}
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Example title="Text roles"><div className="space-y-2 text-sm"><p className="font-medium text-text-primary">Primary text</p><p className="text-text-secondary">Secondary text supports the main hierarchy.</p><p className="text-text-subtle">Subtle text is for quiet metadata.</p><p className="text-text-disabled">Disabled text is intentionally de-emphasized.</p><p className="rounded-lg bg-surface-navigation p-2 text-text-inverse">Inverse text on navigation</p></div></Example>
                <Example title="Borders and elevation"><div className="grid grid-cols-2 gap-3 text-center text-xs text-text-subtle"><div className="rounded-lg border border-border-default p-5">Default</div><div className="rounded-lg border border-border-strong p-5">Strong</div><div className="rounded-lg border border-border-interactive p-5">Interactive</div><div className="rounded-lg border-2 border-border-focus p-5">Focus</div><div className="col-span-2 rounded-lg bg-surface-card p-5 shadow-[var(--shadow-panel)]">Panel elevation</div></div></Example>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{statuses.map(([name, classes, Icon]) => <div key={name} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${classes}`}><Icon className="size-4" />{name}</div>)}</div>
            </Section>

            <Section id="typography" title="Typography" description="Plus Jakarta Sans is the default; workspace branding may replace the sans role without changing hierarchy.">
              <Example title="Hierarchy"><div className="space-y-5"><div><span className="text-xs text-text-subtle">Display</span><p className="text-4xl font-semibold tracking-tight">Product discovery, clarified.</p></div><div><span className="text-xs text-text-subtle">Page title</span><p className="text-2xl font-semibold tracking-tight">Discovery</p></div><div><span className="text-xs text-text-subtle">Section heading</span><p className="text-base font-semibold">Customer opportunities</p></div><p className="max-w-2xl text-sm leading-6 text-text-secondary">Body copy remains compact and readable. Secondary and subtle roles create hierarchy without introducing arbitrary font sizes or colors.</p><code className="rounded bg-surface-inset px-1.5 py-1 font-mono text-xs">pnpm test:e2e</code></div></Example>
            </Section>

            <Section id="controls" title="Controls and content" description="Existing Base UI primitives shown in representative default, disabled, loading, invalid, and empty states.">
              <div className="grid gap-4 lg:grid-cols-2">
                <Example title="Buttons"><div className="flex flex-wrap items-center gap-2"><Button><Plus data-icon="inline-start" />Create</Button><Button variant="secondary">Secondary</Button><Button variant="outline">Outline</Button><Button variant="ghost">Ghost</Button><Button variant="destructive"><Trash2 data-icon="inline-start" />Delete</Button><Button variant="link">Learn more</Button><Button disabled>Disabled</Button><Button disabled><LoaderCircle className="animate-spin" data-icon="inline-start" />Saving</Button></div></Example>
                <Example title="Badges and avatars"><div className="flex flex-wrap items-center gap-2"><Badge>Default</Badge><Badge variant="secondary">Secondary</Badge><Badge variant="outline">Outline</Badge><Badge variant="destructive">Blocked</Badge><AvatarGroup><Avatar><AvatarFallback>RB</AvatarFallback><AvatarBadge /></Avatar><Avatar><AvatarFallback>AK</AvatarFallback></Avatar><AvatarGroupCount>+3</AvatarGroupCount></AvatarGroup></div></Example>
                <Example title="Fields"><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="registry-search">Search</Label><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-text-subtle" /><Input id="registry-search" className="pl-8" placeholder="Find an opportunity" /></div></div><div className="space-y-1.5"><Label htmlFor="registry-invalid">Invalid</Label><Input id="registry-invalid" aria-invalid defaultValue="Missing owner" /><p className="text-xs text-status-danger">Choose an owner.</p></div><div className="space-y-1.5"><Label>Disabled</Label><Input disabled value="Unavailable" readOnly /></div><div className="space-y-1.5"><Label>Status</Label><Select defaultValue="active"><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="paused">Paused</SelectItem></SelectContent></Select></div><div className="space-y-1.5 sm:col-span-2"><Label htmlFor="registry-notes">Notes</Label><Textarea id="registry-notes" placeholder="Add context…" /></div></div></Example>
                <Example title="Selection controls"><div className="space-y-4"><div className="flex items-center gap-2"><Switch id="registry-public" defaultChecked /><Label htmlFor="registry-public">Public roadmap</Label></div><div className="flex items-center gap-2"><Checkbox id="registry-private" defaultChecked /><Label htmlFor="registry-private">Private item</Label></div><div className="flex items-center gap-2"><Switch id="registry-disabled-switch" disabled /><Label htmlFor="registry-disabled-switch" className="text-text-disabled">Unavailable setting</Label></div></div></Example>
                <Example title="Tabs"><Tabs defaultValue="board"><TabsList><TabsTrigger value="board">Board</TabsTrigger><TabsTrigger value="list">List</TabsTrigger><TabsTrigger value="disabled" disabled>Timeline</TabsTrigger></TabsList><TabsContent value="board" className="pt-3 text-text-secondary">Board view content</TabsContent><TabsContent value="list" className="pt-3 text-text-secondary">List view content</TabsContent></Tabs></Example>
                <Example title="Table"><div className="overflow-hidden rounded-lg border border-border-default"><Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Signals</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell className="font-medium">Guided setup</TableCell><TableCell><StatusBadge status="info">Exploring</StatusBadge></TableCell><TableCell className="text-right">8</TableCell></TableRow><TableRow><TableCell className="font-medium">Share experiment results</TableCell><TableCell><StatusBadge status="success">Learned</StatusBadge></TableCell><TableCell className="text-right">3</TableCell></TableRow></TableBody></Table></div></Example>
                <Example title="Collapsible"><Collapsible className="group"><CollapsibleTrigger render={<Button type="button" variant="outline" />}><ChevronDown className="transition-transform group-data-open:rotate-180" />Archived items</CollapsibleTrigger><CollapsibleContent className="pt-3 text-sm text-text-secondary">Archived content remains available without competing with active work.</CollapsibleContent></Collapsible></Example>
                <Example title="Card"><Card><CardHeader><CardTitle>Improve activation guidance</CardTitle><CardDescription>Customer opportunity · Updated today</CardDescription><CardAction><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Opportunity actions" />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>Actions</DropdownMenuLabel><DropdownMenuItem>Edit</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive">Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu></CardAction></CardHeader><CardContent><p className="text-text-secondary">New teams need a clearer first-run path from insight to experiment.</p></CardContent><CardFooter className="justify-between"><Badge variant="outline">High impact</Badge><span className="text-xs text-text-subtle">3 signals</span></CardFooter></Card></Example>
                <Example title="Empty state"><div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface-inset px-6 text-center"><div className="rounded-full bg-surface-panel p-2 shadow-[var(--shadow-card)]"><Search className="size-5 text-text-subtle" /></div><h4 className="mt-3 text-sm font-semibold">No opportunities found</h4><p className="mt-1 max-w-xs text-sm text-text-subtle">Adjust your filters or create the first opportunity for this outcome.</p><Button className="mt-4" size="sm"><Plus />Create opportunity</Button></div></Example>
              </div>
            </Section>

            <Section id="patterns" title="Product patterns" description="Reusable Compass compositions above primitives. These APIs standardize anatomy while leaving domain content to workflows.">
              <div className="space-y-4">
                <Example title="Page header, toolbar, and section"><div className="space-y-6"><PageHeader eyebrow="Discovery" title="Customer opportunities" description="Connect evidence to opportunities and explore solutions." actions={<Button><Plus />New opportunity</Button>} /><Toolbar leading={<Input aria-label="Search opportunities" placeholder="Search opportunities" />} filters={<FilterBar><StatusBadge status="info">Owner: Rick</StatusBadge><StatusBadge status="neutral">Open</StatusBadge></FilterBar>} actions={<Button variant="outline">Export</Button>} /><PageSection title="Recently updated" description="The opportunities with the newest customer evidence."><EntityCard eyebrow="Opportunity" title="Reduce setup uncertainty" description="New teams need guidance during their first product-planning session." status={<StatusBadge status="warning">Review</StatusBadge>} metadata={<MetricBadge label="Signals" value="8" />} footer="Updated today" /></PageSection></div></Example>
                <Example title="Application shell"><div className="h-64 overflow-hidden rounded-xl border border-border-default"><AppShell className="min-h-0 [&>div]:min-h-0" navigation={<div className="p-4 text-sm font-semibold">Compass<br /><span className="mt-6 block rounded-lg bg-surface-navigation-active p-2 font-normal">Discovery</span></div>}><PageHeader title="Workspace" description="Shared shell spacing and main-content semantics." /></AppShell></div></Example>
                <Example title="Board and columns"><Board label="Example opportunity board"><BoardColumn title="Exploring" count={1} accent="info"><EntityCard title="Clarify first-run guidance" description="Synthesize onboarding signals." status={<StatusBadge status="info">Open</StatusBadge>} /></BoardColumn><BoardColumn title="Validating" count={1} accent="warning"><EntityCard title="Test guided setup" description="Prototype a first-session checklist." status={<StatusBadge status="warning">Running</StatusBadge>} /></BoardColumn><BoardColumn title="Learned" count={0} accent="success" emptyState={<EmptyState compact title="Nothing learned yet" description="Concluded experiments appear here." />} /></Board></Example>
                <div className="grid gap-4 lg:grid-cols-2"><Example title="Form field and settings section"><SettingsSection title="Workspace defaults" description="Applied to new opportunities."><FormField id="registry-pattern-name" label="Default owner" description="The teammate responsible for new work."><Input id="registry-pattern-name" placeholder="Choose an owner" /></FormField></SettingsSection></Example><Example title="Detail panel and loading"><div className="h-80 overflow-hidden rounded-xl border border-border-default"><DetailPanel eyebrow="Opportunity" title="Reduce setup uncertainty" description="Customer onboarding"><DetailPanelSection title="Summary"><p className="text-sm text-text-secondary">Help teams reach their first useful plan with less ambiguity.</p></DetailPanelSection><DetailPanelSection title="Activity"><LoadingState rows={2} label="Loading activity" /></DetailPanelSection></DetailPanel></div></Example></div>
                <Example title="Confirmation pattern"><ConfirmDialog trigger={<Button variant="destructive"><Trash2 />Delete opportunity</Button>} title="Delete opportunity?" description="This permanently removes the opportunity and its links." confirmLabel="Delete" destructive onConfirm={() => undefined} /></Example>
              </div>
            </Section>

            <Section id="overlays" title="Overlays" description="Triggers are fully keyboard accessible; dialogs and sheets manage focus through Base UI.">
              <Example title="Dialog, sheet, menu, and tooltip"><div className="flex flex-wrap gap-2"><Dialog><DialogTrigger render={<Button variant="outline" />}>Open dialog</DialogTrigger><DialogContent><DialogHeader><DialogTitle>Archive opportunity?</DialogTitle><DialogDescription>This removes it from the active board. You can restore it later.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline">Cancel</Button><Button>Archive</Button></DialogFooter></DialogContent></Dialog><Sheet><SheetTrigger render={<Button variant="outline" />}>Open detail panel</SheetTrigger><SheetContent><SheetHeader><SheetTitle>Opportunity details</SheetTitle><SheetDescription>A responsive side panel for contextual work.</SheetDescription></SheetHeader><Separator /><div className="p-4 text-sm text-text-secondary">Panel content remains close to the board context.</div></SheetContent></Sheet><DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" />}>Actions<ChevronDown /></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Edit</DropdownMenuItem><DropdownMenuItem>Duplicate</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive">Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Tooltip><TooltipTrigger render={<Button size="icon" variant="ghost" aria-label="About registry" />}><CircleHelp /></TooltipTrigger><TooltipContent>Repository-native component reference</TooltipContent></Tooltip></div></Example>
            </Section>

            <Section id="responsive" title="Constrained width" description="A narrow preview catches wrapping, target-size, and content hierarchy issues without requiring a separate fixture.">
              <div className="mx-auto max-w-sm rounded-2xl border-4 border-border-strong bg-surface-panel p-4 shadow-[var(--shadow-panel)]"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-medium text-text-subtle">Discovery</p><h3 className="text-lg font-semibold">Opportunities</h3></div><Button size="icon" aria-label="Create opportunity"><Plus /></Button></div><div className="relative mt-4"><Search className="absolute left-2.5 top-2 size-4 text-text-subtle" /><Input className="pl-8" placeholder="Search" /></div><div className="mt-4 space-y-3"><Card size="sm"><CardHeader><CardTitle>Reduce setup uncertainty</CardTitle><CardDescription>8 signals · High impact</CardDescription></CardHeader></Card><Card size="sm"><CardHeader><CardTitle>Make experiment results easier to share</CardTitle><CardDescription>3 signals · Medium impact</CardDescription></CardHeader></Card></div></div>
            </Section>
          </div>
          <footer className="mt-16 border-t border-border-default py-8 text-sm text-text-subtle">Compass UI system · Foundations registry</footer>
        </div>
      </main>
    </TooltipProvider>
  );
}
