import { lazy, type ComponentType } from 'react';
import { createBrowserRouter } from 'react-router';
import { MainLayout } from '@/shared/components/MainLayout';
import { NotFound } from '@/shared/components/NotFound';
import { RouteError } from '@/shared/components/RouteError';
import { RoleGuard } from '@/shared/components/RoleGuard';
import { RecoveryPage } from '@/modules/auth/RecoveryPage';
import { RequestAccessPage } from '@/modules/auth/RequestAccessPage';
import { PrivacyPolicyPage, CookiesPolicyPage, TermsPage } from '@/modules/legal/legalContent';
import { importWithReload } from '@/shared/utils/lazyImportWithReload';

// Carga diferida de páginas: cada ruta se divide en su propio chunk y solo se
// descarga al navegar a ella (reduce el bundle inicial). Las páginas son exports
// nombrados, así que se resuelven con este helper. El <Suspense> está en MainLayout.
// importWithReload maneja el caso de un chunk que ya no existe tras un deploy nuevo
// (ver lazyImportWithReload.ts) — recarga una vez en vez de romper con el error
// genérico de React Router.
function lazyPage<T extends Record<string, ComponentType<any>>>(factory: () => Promise<T>, name: keyof T) {
  return lazy(async () => ({ default: (await importWithReload(factory))[name] }));
}

const Dashboard = lazyPage(() => import('@/modules/dashboard/components/Dashboard'), 'Dashboard');
const CheckIn = lazyPage(() => import('@/modules/attendance/components/CheckIn'), 'CheckIn');
const Students = lazyPage(() => import('@/modules/students/components/Students'), 'Students');
const Practices = lazyPage(() => import('@/modules/practices/components/Practices'), 'Practices');
const Reports = lazyPage(() => import('@/modules/reports/components/Reports'), 'Reports');
const ProfilePage = lazyPage(() => import('@/modules/profile/ProfilePage'), 'ProfilePage');
const RotationsCalendarPage = lazyPage(() => import('@/modules/rotations/components/RotationsCalendarPage'), 'RotationsCalendarPage');
const UserManagement = lazyPage(() => import('@/modules/admin/components/UserManagement'), 'UserManagement');

const DeanDashboardPage = lazyPage(() => import('@/modules/dean/pages/DeanDashboardPage'), 'DeanDashboardPage');
const DeanStudentsPage = lazyPage(() => import('@/modules/dean/pages/DeanStudentsPage'), 'DeanStudentsPage');
const DeanLocationsPage = lazyPage(() => import('@/modules/dean/pages/DeanLocationsPage'), 'DeanLocationsPage');
const DeanJustificationsPage = lazyPage(() => import('@/modules/dean/pages/DeanJustificationsPage'), 'DeanJustificationsPage');
const DeanAssignmentsPage = lazyPage(() => import('@/modules/dean/pages/DeanAssignmentsPage'), 'DeanAssignmentsPage');
const IncidentsDashboardPage = lazyPage(() => import('@/modules/dean/pages/IncidentsDashboardPage'), 'IncidentsDashboardPage');
const HolidaysPage = lazyPage(() => import('@/modules/dean/pages/HolidaysPage'), 'HolidaysPage');
const AcademicCatalogPage = lazyPage(() => import('@/modules/dean/pages/AcademicCatalogPage'), 'AcademicCatalogPage');

const StudentDashboardPage = lazyPage(() => import('@/modules/students/components/StudentDashboardPage'), 'StudentDashboardPage');
const StudentQrScannerPage = lazyPage(() => import('@/modules/students/components/StudentQrScannerPage'), 'StudentQrScannerPage');
const StudentProgressPage = lazyPage(() => import('@/modules/students/components/StudentProgressPage'), 'StudentProgressPage');
const StudentHistoryPage = lazyPage(() => import('@/modules/students/components/StudentHistoryPage'), 'StudentHistoryPage');
const StudentJustificationsPage = lazyPage(() => import('@/modules/students/components/StudentJustificationsPage'), 'StudentJustificationsPage');
const StudentAssignmentPage = lazyPage(() => import('@/modules/students/components/StudentAssignmentPage'), 'StudentAssignmentPage');

const TeacherDashboardPage = lazyPage(() => import('@/modules/teacher/pages/TeacherDashboardPage'), 'TeacherDashboardPage');
const TeacherEvaluationsPage = lazyPage(() => import('@/modules/teacher/pages/TeacherEvaluationsPage'), 'TeacherEvaluationsPage');
const TeacherDecisionHistoryPage = lazyPage(() => import('@/modules/teacher/pages/TeacherDecisionHistoryPage'), 'TeacherDecisionHistoryPage');

const HospitalLivePage = lazyPage(() => import('@/modules/hospital/pages/HospitalLivePage'), 'HospitalLivePage');
const HospitalIncidentsPage = lazyPage(() => import('@/modules/hospital/pages/HospitalIncidentsPage'), 'HospitalIncidentsPage');
const HospitalSubjectsPage = lazyPage(() => import('@/modules/hospital/pages/HospitalSubjectsPage'), 'HospitalSubjectsPage');

// Auditoría 2026-10-06 (M-4): estas rutas del encargado no tenían guard y un
// alumno podía abrir la UI de registro manual o los reportes. Los datos ya estaban
// protegidos por RLS; el guard evita pantallas rotas o engañosas.
const STAFF_ROLES: Parameters<typeof RoleGuard>[0]['allow'] = ['ADMIN', 'COORDINATOR', 'COORDINADOR'];
const CheckInRoute = () => (
  <RoleGuard allow={STAFF_ROLES}>
    <CheckIn />
  </RoleGuard>
);
const StudentsRoute = () => (
  <RoleGuard allow={STAFF_ROLES}>
    <Students />
  </RoleGuard>
);
const PracticesRoute = () => (
  <RoleGuard allow={STAFF_ROLES}>
    <Practices />
  </RoleGuard>
);
const ReportsRoute = () => (
  <RoleGuard allow={STAFF_ROLES}>
    <Reports />
  </RoleGuard>
);

const DeanDashboardRoute = () => (
  <RoleGuard allow={['ADMIN']}>
    <DeanDashboardPage />
  </RoleGuard>
);

const DeanStudentsRoute = () => (
  <RoleGuard allow={['ADMIN']}>
    <DeanStudentsPage />
  </RoleGuard>
);

const DeanLocationsRoute = () => (
  <RoleGuard allow={['ADMIN', 'COORDINATOR', 'COORDINADOR', 'TEACHER', 'DOCENTE']}>
    <DeanLocationsPage />
  </RoleGuard>
);

const DeanJustificationsRoute = () => (
  <RoleGuard allow={['ADMIN', 'COORDINATOR', 'COORDINADOR', 'TEACHER', 'DOCENTE']}>
    <DeanJustificationsPage />
  </RoleGuard>
);

const IncidentsDashboardRoute = () => (
  <RoleGuard allow={['ADMIN', 'COORDINATOR', 'COORDINADOR', 'TEACHER', 'DOCENTE']}>
    <IncidentsDashboardPage />
  </RoleGuard>
);

const UsersRoute = () => (
  <RoleGuard allow={['ADMIN', 'TEACHER', 'DOCENTE']}>
    <UserManagement />
  </RoleGuard>
);

const AssignmentsRoute = () => (
  <RoleGuard allow={['ADMIN', 'COORDINATOR', 'COORDINADOR']}>
    <DeanAssignmentsPage />
  </RoleGuard>
);

const HolidaysRoute = () => (
  <RoleGuard allow={['ADMIN', 'COORDINATOR', 'COORDINADOR', 'TEACHER', 'DOCENTE']}>
    <HolidaysPage />
  </RoleGuard>
);

const CatalogRoute = () => (
  <RoleGuard allow={['ADMIN', 'COORDINATOR', 'COORDINADOR']}>
    <AcademicCatalogPage />
  </RoleGuard>
);

const StudentDashboardRoute = () => (
  <RoleGuard allow={['STUDENT']}>
    <StudentDashboardPage />
  </RoleGuard>
);

const StudentQrRoute = () => (
  <RoleGuard allow={['STUDENT']}>
    <StudentQrScannerPage />
  </RoleGuard>
);

const StudentHistoryRoute = () => (
  <RoleGuard allow={['STUDENT']}>
    <StudentHistoryPage />
  </RoleGuard>
);

const StudentProgressRoute = () => (
  <RoleGuard allow={['STUDENT']}>
    <StudentProgressPage />
  </RoleGuard>
);

const StudentJustificationsRoute = () => (
  <RoleGuard allow={['STUDENT']}>
    <StudentJustificationsPage />
  </RoleGuard>
);

const StudentAssignmentRoute = () => (
  <RoleGuard allow={['STUDENT']}>
    <StudentAssignmentPage />
  </RoleGuard>
);

// Rutas del Docente (T-00.1).
const TeacherDashboardRoute = () => (
  <RoleGuard allow={['DOCENTE', 'TEACHER']}>
    <TeacherDashboardPage />
  </RoleGuard>
);

const TeacherEvaluationsRoute = () => (
  <RoleGuard allow={['DOCENTE', 'TEACHER']}>
    <TeacherEvaluationsPage />
  </RoleGuard>
);

const TeacherHistoryRoute = () => (
  <RoleGuard allow={['DOCENTE', 'TEACHER']}>
    <TeacherDecisionHistoryPage />
  </RoleGuard>
);

// Rutas del Representante Hospitalario (HU-38 / HU-40).
const HospitalLiveRoute = () => (
  <RoleGuard allow={['REPRESENTATIVE']}>
    <HospitalLivePage />
  </RoleGuard>
);

const HospitalIncidentsRoute = () => (
  <RoleGuard allow={['REPRESENTATIVE']}>
    <HospitalIncidentsPage />
  </RoleGuard>
);

const HospitalSubjectsRoute = () => (
  <RoleGuard allow={['REPRESENTATIVE']}>
    <HospitalSubjectsPage />
  </RoleGuard>
);

export const router = createBrowserRouter([
  { path: '/auth/recovery', Component: RecoveryPage, errorElement: <RouteError /> },
  { path: '/auth/request-access', Component: RequestAccessPage, errorElement: <RouteError /> },
  { path: '/legal/privacy', Component: PrivacyPolicyPage, errorElement: <RouteError /> },
  { path: '/legal/cookies', Component: CookiesPolicyPage, errorElement: <RouteError /> },
  { path: '/legal/terms', Component: TermsPage, errorElement: <RouteError /> },
  {
    path: '/',
    Component: MainLayout,
    errorElement: <RouteError />,
    children: [
      { index: true, Component: Dashboard },
      { path: 'checkin', Component: CheckInRoute },
      { path: 'students', Component: StudentsRoute },
      { path: 'practices', Component: PracticesRoute },
      { path: 'reports', Component: ReportsRoute },
      { path: 'users', Component: UsersRoute },
      { path: 'profile', Component: ProfilePage },
      { path: 'rotations', Component: RotationsCalendarPage },
      { path: 'student/dashboard', Component: StudentDashboardRoute },
      { path: 'student/qr', Component: StudentQrRoute },
      { path: 'student/history', Component: StudentHistoryRoute },
      { path: 'student/progress', Component: StudentProgressRoute },
      { path: 'student/justifications', Component: StudentJustificationsRoute },
      { path: 'student/assignment', Component: StudentAssignmentRoute },
      { path: 'dean/dashboard', Component: DeanDashboardRoute },
      { path: 'dean/students', Component: DeanStudentsRoute },
      { path: 'dean/locations', Component: DeanLocationsRoute },
      { path: 'dean/justifications', Component: DeanJustificationsRoute },
      { path: 'dean/assignments', Component: AssignmentsRoute },
      { path: 'dean/holidays', Component: HolidaysRoute },
      { path: 'dean/catalog', Component: CatalogRoute },
      { path: 'dean/incidents', Component: IncidentsDashboardRoute },
      { path: 'teacher/dashboard', Component: TeacherDashboardRoute },
      { path: 'teacher/evaluations', Component: TeacherEvaluationsRoute },
      { path: 'teacher/history', Component: TeacherHistoryRoute },
      { path: 'hospital/live', Component: HospitalLiveRoute },
      { path: 'hospital/subjects', Component: HospitalSubjectsRoute },
      { path: 'hospital/incidents', Component: HospitalIncidentsRoute },
      { path: '*', Component: NotFound },
    ],
  },
]);
