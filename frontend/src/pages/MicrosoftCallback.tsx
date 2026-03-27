import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// Microsoft redirects to /auth/microsoft/callback?code=...&state=...
// We forward to the edge function which exchanges the code and redirects to /settings?ms_connected=1
const MicrosoftCallback = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code  = params.get('code');
    const state = params.get('state');
    const error = params.get('error');

    if (error) {
      navigate(`/settings?ms_error=${encodeURIComponent(error)}`);
      return;
    }

    if (!code || !state) {
      navigate('/settings?ms_error=missing_params');
      return;
    }

    // Hand off to edge function callback handler
    const callbackUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/microsoft-oauth/callback?${params.toString()}`;
    window.location.href = callbackUrl;
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-3">
        <div className="h-8 w-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-sm text-muted-foreground">Connecting Microsoft account...</p>
      </div>
    </div>
  );
};

export default MicrosoftCallback;
