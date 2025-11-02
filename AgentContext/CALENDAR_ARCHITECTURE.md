# Calendar Architecture: Server vs Client Components

## Overview

This calendar application uses **Next.js App Router** with a hybrid approach, but the architecture is primarily **client-side heavy** rather than using the "client islands" pattern.

## Server-Side Components (RSC)

### 1. **Page Component** (`app/calendar/page.tsx`)
- **Type**: Server Component (async function)
- **Purpose**: Entry point that handles authentication
- **Responsibilities**:
  - Authenticates user session using `auth.api.getSession()`
  - Redirects to `/login` if not authenticated
  - Renders the client-side provider tree

```tsx
export default async function CalendarPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  
  return (
    <ZonedDateTimeProvider>
      <DateProvider>
        <CalendarLayout />
      </DateProvider>
    </ZonedDateTimeProvider>
  );
}
```

## Client-Side Components ("use client")

Almost **everything else** is a client component. The entire calendar UI is client-side.

### **Root Layout Components**
- `CalendarLayout` - Main layout wrapper
- `DateProvider` - Context provider for current date (with timer for day transitions)
- `ZonedDateTimeProvider` - Context provider for current date-time (with minute/second ticks)

### **Core Calendar Components**
- `CalendarView` - Main calendar container
- `CalendarContent` - Renders appropriate view based on state
- `CalendarHeader` - Header with navigation controls

### **View Components** (All client-side)
- `MonthView` - Month calendar grid
- `WeekView` - Week timeline view
- `DayView` - Single day timeline view
- `AgendaView` - List/agenda view
- `Timeline` - Time labels for day/week views

### **Sidebar Components**
- `AppSidebar` - Left sidebar (uses hooks, imported into client component)
- `RightSidebar` - Right sidebar wrapper
- `EventForm` - Event creation/editing form in right sidebar

### **Interactive Components**
- `DatePicker` - Date selection widget
- `CalendarPicker` - Calendar account selection
- `AppCommandMenu` - Command palette (Cmd+K)
- `EventHotkeys` - Keyboard shortcuts handler
- `CalendarHotkeys` - Calendar-specific shortcuts

### **Event Components**
- `DraggableEvent` - Drag-and-drop event items
- `EventItem` - Event display component
- `EventContextMenu` - Right-click menu for events

### **State Management**
- Uses **Jotai** atoms for state (all client-side):
  - `calendarSettingsAtom`
  - `viewPreferencesAtom`
  - `calendarPreferencesAtom`
  - `currentDateAtom`
  - `cellHeightAtom`
  - `optimisticActionsByEventIdAtom`

### **Data Fetching**
- Uses **React Query** (TanStack Query) with tRPC for data fetching
- `useEventsForDisplay()` hook fetches events client-side
- Events are cached in IndexedDB (`db.events.bulkPut()`)

## Architecture Pattern

### ❌ **NOT Client Islands Pattern**

This application does **NOT** use the client islands pattern (where isolated interactive components are client-side while most content is server-rendered).

Instead, it uses:

### ✅ **Single Large Client Island Pattern**

The entire calendar UI is client-side:
- **Server**: Only authentication check
- **Client**: Everything else (100% of the UI)

### Why This Architecture?

1. **Heavy Interactivity**: Calendar requires extensive client-side interactivity:
   - Drag-and-drop events
   - Real-time date/time updates
   - Keyboard shortcuts
   - Scroll position management
   - Form state management

2. **Real-time Updates**: 
   - `DateProvider` updates every day at midnight
   - `ZonedDateTimeProvider` updates every minute/second
   - Current time indicators
   - These require client-side timers

3. **State Management**: 
   - Complex state with Jotai atoms
   - Optimistic updates
   - View preferences
   - Calendar preferences

4. **Data Fetching**: 
   - Client-side data fetching with React Query
   - IndexedDB caching
   - Optimistic mutations

## Component Dependency Tree

```
app/calendar/page.tsx (SERVER)
  └─ ZonedDateTimeProvider (CLIENT)
      └─ DateProvider (CLIENT)
          └─ CalendarLayout (CLIENT)
              ├─ AppSidebar (CLIENT - uses hooks)
              │   ├─ DatePicker (CLIENT)
              │   └─ NavUser (CLIENT)
              ├─ CalendarView (CLIENT)
              │   ├─ CalendarHeader (CLIENT)
              │   └─ CalendarContent (CLIENT)
              │       ├─ MonthView (CLIENT)
              │       ├─ WeekView (CLIENT)
              │       ├─ DayView (CLIENT)
              │       └─ AgendaView (CLIENT)
              ├─ EventHotkeys (CLIENT)
              ├─ AppCommandMenu (CLIENT)
              └─ RightSidebar (CLIENT)
                  └─ EventForm (CLIENT)
```

## Key Client-Side Features

### State & Interactivity
- ✅ View switching (month/week/day/agenda)
- ✅ Date navigation
- ✅ Calendar preferences (show/hide calendars)
- ✅ View preferences (show weekends, past events)
- ✅ Drag-and-drop event repositioning
- ✅ Event creation/editing forms
- ✅ Keyboard shortcuts
- ✅ Scroll position management

### Real-time Features
- ✅ Current time indicator
- ✅ Auto-refresh at midnight
- ✅ Minute-by-minute updates (optional)

### Data Operations
- ✅ Optimistic updates
- ✅ IndexedDB caching
- ✅ Client-side filtering
- ✅ Event mutations

## Performance Considerations

### Pros of Current Architecture
- ✅ Fast initial page load (server auth check)
- ✅ Smooth interactivity (everything client-side)
- ✅ No hydration mismatches
- ✅ Efficient state management

### Cons / Potential Improvements
- ⚠️ Large client bundle (all calendar code shipped to client)
- ⚠️ No SSR for calendar content (events, initial state)
- ⚠️ SEO concerns (though calendar is typically authenticated)

## Summary

**Server Components**: Only the page entry point (`app/calendar/page.tsx`)

**Client Components**: ~99% of the application

**Pattern**: Single large client island (not client islands)

**Why**: Heavy interactivity, real-time updates, complex state management, and client-side data fetching requirements make this architecture suitable for a calendar application.

