import React from 'react';

export const CompanyDetails = ({ analystCompany }) => {
  if (!analystCompany) return null;
  return (
    <div className="glass-panel" style={{ background: '#f0f7f4', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '12px', padding: '1.25rem', marginBottom: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
        {analystCompany.image && (
          <img src={analystCompany.image} alt={analystCompany.name} style={{ width: '48px', height: '48px', borderRadius: '8px', objectFit: 'contain', background: '#ffffff', padding: '4px', border: '1px solid rgba(0,0,0,0.05)' }} />
        )}
        <div>
          <h4 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{analystCompany.name}</h4>
          <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#047857', fontWeight: 600 }}>
            📁 {analystCompany.sector || 'General Stock'}
          </span>
        </div>
      </div>
      {analystCompany.description && (
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.5', marginTop: '0.5rem' }}>
          {analystCompany.description}
        </p>
      )}
    </div>
  );
};
