import { AdminLoginForm } from "@/components/admin-login-form";

export default function AdminLoginPage() {
  return (
    <main className="page-main">
      <section className="page-section">
        <div className="app-container page-stack">
          <div className="page-header">
            <div className="page-eyebrow">Internal workspace</div>
            <h1 className="section-title">Review the supply queue</h1>
            <p className="page-copy">
              Use the shared admin token to review submitted provider services, assign settlement tiers, and triage
              endpoint or source requests.
            </p>
          </div>
          <AdminLoginForm />
        </div>
      </section>
    </main>
  );
}
