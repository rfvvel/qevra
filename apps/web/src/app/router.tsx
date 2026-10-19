import { RegisterPage } from '../features/auth/register';
import { AnalyticsPage } from '../features/analytics/analytics-page';
import { CheckoutPage } from '../features/customer/checkout-page';
import { CustomerLayout } from '../features/customer/layout';
import { JoinPage } from '../features/customer/join-page';
import { TicketPage } from '../features/customer/ticket-page';
import { LandingPage } from '../features/landing/landing-page';
import { QueuePage } from '../features/queues/queue-page';
import { createBrowserRouter, Link } from 'react-router-dom';
import { PublicLayout, BusinessLayout, WorkspaceLayout } from '../components/layouts';
import { RequireStaffSession } from './auth-context';
import { LoginPage } from '../features/auth/login';
import { BusinessSelectorPage, OnboardingPage, BusinessOverviewPage } from '../features/configuration/business-pages';
import { BranchesPage, BranchDetailPage } from '../features/configuration/branch-pages';
import { ServicesPage, ServiceSettingsPage } from '../features/configuration/service-pages';
import { StaffPage } from '../features/configuration/staff-page';
import { PublicBranchPage } from '../features/public/branch-page';
export const router = createBrowserRouter([
  ...(import.meta.env.DEV ? [{ path: '/__verify', lazy: async () => ({ Component: (await import('../dev/runtime-verification')).RuntimeVerification }) }] : []),
  { path: '/', element: <LandingPage /> },
  { element: <PublicLayout />, children: [
    { path: '/register', element: <RegisterPage /> },
    { path: '/login', element: <LoginPage /> },
    { path: '*', element: <div><h1 className="mb-4 text-3xl font-semibold">Page not found</h1><Link className="text-teal-800 underline" to="/">Return home</Link></div> },
  ] },
  { element: <CustomerLayout />, children: [
    { path: '/q/:branchSlug', element: <PublicBranchPage /> },
    { path: '/q/:branchSlug/services/:serviceId/join', element: <JoinPage /> },
    { path: '/checkout/:joinRequestId', element: <CheckoutPage /> },
    { path: '/ticket/:ticketId', element: <TicketPage /> },
  ] },
  { element: <RequireStaffSession />, children: [{ element: <BusinessLayout />, children: [
    { path: '/app', element: <BusinessSelectorPage /> },
    { path: '/app/onboarding', element: <OnboardingPage /> },
    { path: '/app/:businessId', element: <WorkspaceLayout />, children: [
      { index: true, element: <BusinessOverviewPage /> },
      { path: 'branches', element: <BranchesPage /> },
      { path: 'branches/:branchId', element: <BranchDetailPage /> },
      { path: 'branches/:branchId/services', element: <ServicesPage /> },
      { path: 'branches/:branchId/services/:serviceId/settings', element: <ServiceSettingsPage /> },
      { path: 'branches/:branchId/services/:serviceId/queue', element: <QueuePage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'staff', element: <StaffPage /> },
    ] },
  ] }] },
]);
