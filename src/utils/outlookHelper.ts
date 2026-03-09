/**
 * Helper utilities for creating Outlook prefilled emails
 */

interface OutlookEmailParams {
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
}

/**
 * Opens Outlook desktop app with prefilled email
 * Uses the outlook: protocol which works on Windows
 */
export const openOutlookDesktop = (params: OutlookEmailParams): void => {
  const { to, cc, bcc, subject, body } = params;
  
  const parts: string[] = [`outlook:?to=${encodeURIComponent(to)}`];
  
  if (cc) parts.push(`cc=${encodeURIComponent(cc)}`);
  if (bcc) parts.push(`bcc=${encodeURIComponent(bcc)}`);
  if (subject) parts.push(`subject=${encodeURIComponent(subject)}`);
  if (body) parts.push(`body=${encodeURIComponent(body)}`);
  
  const outlookUrl = parts.join('&');
  window.location.href = outlookUrl;
};

/**
 * Opens Outlook Web App with prefilled email
 * Works on any platform with browser
 */
export const openOutlookWeb = (params: OutlookEmailParams): void => {
  const { to, cc, bcc, subject, body } = params;
  
  const baseUrl = 'https://outlook.office.com/mail/deeplink/compose';
  const urlParams = new URLSearchParams();
  
  urlParams.append('to', to);
  if (cc) urlParams.append('cc', cc);
  if (bcc) urlParams.append('bcc', bcc);
  if (subject) urlParams.append('subject', subject);
  if (body) urlParams.append('body', body);
  
  const outlookWebUrl = `${baseUrl}?${urlParams.toString()}`;
  window.open(outlookWebUrl, '_blank');
};

/**
 * Creates a mailto link with prefilled content
 * Works universally across all email clients
 */
export const createMailtoLink = (params: OutlookEmailParams): string => {
  const { to, cc, bcc, subject, body } = params;
  
  const parts: string[] = [];
  
  if (cc) parts.push(`cc=${encodeURIComponent(cc)}`);
  if (bcc) parts.push(`bcc=${encodeURIComponent(bcc)}`);
  if (subject) parts.push(`subject=${encodeURIComponent(subject)}`);
  if (body) parts.push(`body=${encodeURIComponent(body)}`);
  
  const queryString = parts.length > 0 ? `?${parts.join('&')}` : '';
  return `mailto:${encodeURIComponent(to)}${queryString}`;
};

/**
 * Opens default mail client with prefilled email
 */
export const openMailto = (params: OutlookEmailParams): void => {
  const mailtoUrl = createMailtoLink(params);
  window.location.href = mailtoUrl;
};

/**
 * Detects which method to use based on user preference and platform
 */
export const openPrefilledEmail = (
  params: OutlookEmailParams,
  method: 'desktop' | 'web' | 'default' = 'default'
): void => {
  switch (method) {
    case 'desktop':
      openOutlookDesktop(params);
      break;
    case 'web':
      openOutlookWeb(params);
      break;
    case 'default':
    default:
      openMailto(params);
      break;
  }
};
