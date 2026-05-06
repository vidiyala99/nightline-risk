"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTenantId, useAuth } from "@/contexts/AuthContext";
import { toastSuccess, toastError } from "@/lib/toast";
import { CheckSquare, Upload, Clock, AlertCircle, LogOut } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface ComplianceItem {
  id: string;
  description: string;
  severity: string;
}

export default function CompliancePage() {
  const router = useRouter();
  const { signOut, isSignedIn, isLoaded } = useAuth();
  const tenantId = useTenantId();
  const [complianceItems, setComplianceItems] = useState<ComplianceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isSignedIn) {
      router.push("/login");
    }
  }, [isSignedIn, router]);

  useEffect(() => {
    async function fetchCompliance() {
      if (!tenantId) {
        setComplianceItems([]);
        setLoading(false);
        return;
      }

      try {
        const res = await fetch(`${API_URL}/api/venues/${tenantId}/live`);
        if (res.ok) {
          const state = await res.json();
          setComplianceItems(state.compliance_queue || []);
        }
      } catch (error) {
        console.error("Failed to fetch compliance:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchCompliance();
  }, [tenantId]);

  const handleUpload = async (itemId: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !tenantId) return;

    setUploadingId(itemId);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${API_URL}/api/venues/${tenantId}/compliance/${itemId}/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error("Upload failed");
      
      toastSuccess("Evidence uploaded successfully");
      setComplianceItems((prev) => prev.filter((item) => item.id !== itemId));
    } catch (error) {
      toastError("Failed to upload evidence");
      console.error(error);
    } finally {
      setUploadingId(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleSignOut = () => {
    signOut();
    router.push("/login");
  };

  if (!isSignedIn || loading) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="theme-venue page">
      <header className="page-header">
        <div>
          <h1>Compliance</h1>
          <p className="page-subtitle">
            Complete pending compliance actions to maintain coverage
          </p>
        </div>
        <button onClick={handleSignOut} className="btn btn-ghost">
          <LogOut size={18} />
          Sign Out
        </button>
      </header>

      {complianceItems.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <CheckSquare size={48} />
          </div>
          <h2>All Clear</h2>
          <p>No pending compliance actions at this time.</p>
        </div>
      ) : (
        <div className="compliance-grid">
          {complianceItems.map((item) => (
            <div key={item.id} className="compliance-card">
              <div className="compliance-header">
                <AlertCircle size={18} />
                <span>{item.id}</span>
              </div>
              <p className="compliance-desc">{item.description}</p>
              <div className="compliance-meta">
                <span className="severity-tag">
                  <Clock size={12} />
                  {item.severity}
                </span>
              </div>
              <div className="compliance-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,image/*,application/pdf"
                  className="visually-hidden"
                  onChange={(e) => handleUpload(item.id, e)}
                />
                <button
                  className="btn btn-secondary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingId === item.id}
                >
                  {uploadingId === item.id ? (
                    <>
                      <div className="loading-spinner loading-spinner-sm" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Upload size={18} />
                      Upload Evidence
                    </>
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
