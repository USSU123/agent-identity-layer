/**
 * Agent Identity Badge Embed Script
 * Usage: <script src="https://agent-identity.onrender.com/badge.js" 
 *               data-did="did:agent:abc123"
 *               data-size="small"
 *               data-theme="light"></script>
 * 
 * Options:
 *   data-did: The agent's DID (required)
 *   data-size: "small" (default) or "medium"
 *   data-theme: "light" (default) or "dark"
 */
(function() {
  'use strict';

  const API_BASE = 'https://agent-identity.onrender.com';
  
  // Find the current script tag
  const script = document.currentScript;
  if (!script) {
    console.error('[AgentIdentity] Could not find script tag');
    return;
  }

  const did = script.getAttribute('data-did');
  const size = script.getAttribute('data-size') || 'small';
  const theme = script.getAttribute('data-theme') || 'light';

  if (!did) {
    console.error('[AgentIdentity] data-did attribute is required');
    return;
  }

  // Styles
  const styles = {
    light: {
      bg: '#ffffff',
      bgHover: '#f9fafb',
      border: '#e5e7eb',
      text: '#111827',
      textSecondary: '#6b7280',
      verified: '#10b981',
      unverified: '#ef4444',
      tooltip: '#111827',
      tooltipText: '#ffffff'
    },
    dark: {
      bg: '#1f2937',
      bgHover: '#374151',
      border: '#374151',
      text: '#f9fafb',
      textSecondary: '#9ca3af',
      verified: '#34d399',
      unverified: '#f87171',
      tooltip: '#f9fafb',
      tooltipText: '#111827'
    }
  };

  const sizes = {
    small: { padding: '6px 12px', fontSize: '13px', iconSize: '14px', gap: '6px' },
    medium: { padding: '8px 16px', fontSize: '14px', iconSize: '16px', gap: '8px' }
  };

  const colors = styles[theme] || styles.light;
  const sizeConfig = sizes[size] || sizes.small;

  // Create container
  const container = document.createElement('div');
  container.className = 'agent-identity-badge';
  container.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: ${sizeConfig.gap};
    padding: ${sizeConfig.padding};
    background: ${colors.bg};
    border: 1px solid ${colors.border};
    border-radius: 6px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: ${sizeConfig.fontSize};
    color: ${colors.text};
    cursor: pointer;
    position: relative;
    transition: all 0.2s ease;
    text-decoration: none;
  `;

  // Loading state
  container.innerHTML = `
    <span style="color: ${colors.textSecondary}; font-size: ${sizeConfig.iconSize};">⏳</span>
    <span style="color: ${colors.textSecondary};">Verifying...</span>
  `;

  // Insert badge after script
  script.parentNode.insertBefore(container, script.nextSibling);

  // Create tooltip
  const tooltip = document.createElement('div');
  tooltip.style.cssText = `
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 8px;
    padding: 12px 16px;
    background: ${colors.tooltip};
    color: ${colors.tooltipText};
    border-radius: 8px;
    font-size: 13px;
    white-space: nowrap;
    opacity: 0;
    visibility: hidden;
    transition: all 0.2s ease;
    z-index: 1000;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    pointer-events: none;
  `;

  // Fetch agent data
  fetch(`${API_BASE}/verify/${encodeURIComponent(did)}`)
    .then(response => {
      if (!response.ok) throw new Error('Network response was not ok');
      return response.json();
    })
    .then(data => {
      if (data.verified) {
        // Verified agent
        const stars = '★'.repeat(Math.floor(data.reputation)) + 
                     (data.reputation % 1 >= 0.5 ? '½' : '') +
                     '☆'.repeat(5 - Math.ceil(data.reputation));
        
        container.innerHTML = `
          <span style="color: ${colors.verified}; font-size: ${sizeConfig.iconSize};">✓</span>
          <span>Verified Agent</span>
        `;
        
        container.style.borderColor = colors.verified;
        
        tooltip.innerHTML = `
          <div style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(data.name)}</div>
          <div style="color: ${theme === 'dark' ? '#9ca3af' : '#6b7280'}; font-size: 12px;">
            <div>⭐ ${data.reputation.toFixed(1)} reputation</div>
            <div>📋 ${data.tasks_completed} tasks completed</div>
          </div>
        `;
        
        container.onclick = () => {
          window.open(data.verification_url, '_blank');
        };
      } else {
        // Unverified agent
        container.innerHTML = `
          <span style="color: ${colors.unverified}; font-size: ${sizeConfig.iconSize};">✗</span>
          <span style="color: ${colors.textSecondary};">Unverified</span>
        `;
        
        tooltip.innerHTML = `
          <div style="font-weight: 600; margin-bottom: 4px;">Agent Not Registered</div>
          <div style="color: ${theme === 'dark' ? '#9ca3af' : '#6b7280'}; font-size: 12px;">
            Click to learn about Agent Identity
          </div>
        `;
        
        container.onclick = () => {
          window.open(data.register_url || `${API_BASE}/`, '_blank');
        };
      }
      
      container.appendChild(tooltip);
      
      // Hover effects
      container.onmouseenter = () => {
        container.style.background = colors.bgHover;
        tooltip.style.opacity = '1';
        tooltip.style.visibility = 'visible';
      };
      
      container.onmouseleave = () => {
        container.style.background = colors.bg;
        tooltip.style.opacity = '0';
        tooltip.style.visibility = 'hidden';
      };
    })
    .catch(error => {
      console.error('[AgentIdentity] Verification failed:', error);
      container.innerHTML = `
        <span style="color: ${colors.textSecondary}; font-size: ${sizeConfig.iconSize};">⚠</span>
        <span style="color: ${colors.textSecondary};">Verification unavailable</span>
      `;
    });

  // Helper function to escape HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
})();
