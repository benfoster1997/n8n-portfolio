import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { configBadUrl, configMissing } from './api';
import { AdminLayout, OwnerGate } from './components/owner';
import { ToastProvider } from './components/ui';
import { AppointmentNew } from './pages/admin/AppointmentNew';
import { AppointmentView } from './pages/admin/AppointmentView';
import { ClientView } from './pages/admin/ClientView';
import { Clients } from './pages/admin/Clients';
import { Diary } from './pages/admin/Diary';
import { Money } from './pages/admin/Money';
import { Reminders } from './pages/admin/Reminders';
import {
  AccountSettings, BackupSettings, BookingPageSettings, BusinessSettings, DepositSettings, EmailSettings, HoursSettings,
  MessageSettings, RulesSettings, ServicesSettings, SettingsHome, TimeOffSettings,
} from './pages/admin/Settings';
import { Today } from './pages/admin/Today';
import { Book } from './pages/public/Book';
import { FormPage } from './pages/public/FormPage';
import { Manage } from './pages/public/Manage';
import { Privacy } from './pages/public/Privacy';

export function App() {
  if (configMissing) {
    return (
      <div className="page stack">
        <h1>Not set up yet</h1>
        <p>This booking app isn’t connected to its database. If you run it, add <code>VITE_SUPABASE_URL</code> and{' '}
          <code>VITE_SUPABASE_ANON_KEY</code> in Netlify’s environment variables and deploy again (SETUP.md step 2), or set{' '}
          <code>VITE_DEMO=1</code> to show the demo.</p>
      </div>
    );
  }
  if (configBadUrl) {
    return (
      <div className="page stack">
        <h1>Not connected yet</h1>
        <p>This booking app can’t reach its database: the database address saved in Netlify isn’t right. If you run it, change{' '}
          <code>VITE_SUPABASE_URL</code> so it looks exactly like <code>https://abcdefghijklmnop.supabase.co</code>, copied from
          Supabase → Project Settings → Data API, with nothing before it and no quote marks. Save it and deploy again
          (Deploys → Trigger deploy).</p>
      </div>
    );
  }
  return (
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          {/* Public pages: clients use these, no sign-in. */}
          <Route path="/book" element={<Book />} />
          <Route path="/form/:token" element={<FormPage />} />
          <Route path="/manage/:token" element={<Manage />} />
          <Route path="/privacy" element={<Privacy />} />

          {/* Everything else is the owner's diary. */}
          <Route element={<OwnerGate><AdminLayout /></OwnerGate>}>
            <Route index element={<Today />} />
            <Route path="diary" element={<Diary />} />
            <Route path="reminders" element={<Reminders />} />
            <Route path="appointments/new" element={<AppointmentNew />} />
            <Route path="appointments/:id" element={<AppointmentView />} />
            <Route path="clients" element={<Clients />} />
            <Route path="clients/:id" element={<ClientView />} />
            <Route path="money" element={<Money />} />
            <Route path="settings" element={<SettingsHome />} />
            <Route path="settings/business" element={<BusinessSettings />} />
            <Route path="settings/booking-page" element={<BookingPageSettings />} />
            <Route path="settings/hours" element={<HoursSettings />} />
            <Route path="settings/services" element={<ServicesSettings />} />
            <Route path="settings/time-off" element={<TimeOffSettings />} />
            <Route path="settings/rules" element={<RulesSettings />} />
            <Route path="settings/deposits" element={<DepositSettings />} />
            <Route path="settings/messages" element={<MessageSettings />} />
            <Route path="settings/email" element={<EmailSettings />} />
            <Route path="settings/backup" element={<BackupSettings />} />
            <Route path="settings/account" element={<AccountSettings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
