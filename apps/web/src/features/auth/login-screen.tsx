'use client';

import { useState, type FormEvent } from 'react';
import { sellerClient, SellerHttpError } from '@/lib/seller-client';
import { Brand } from './brand';

export function LoginScreen() {
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await sellerClient.login({ email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') });
      window.location.replace('/route');
    } catch (failure) {
      setError(failure instanceof SellerHttpError && [400, 401, 403].includes(failure.status)
        ? 'Não foi possível entrar. Confira seu e-mail, senha e acesso de vendedor.'
        : 'Não foi possível conectar. Confira sua conexão e tente novamente.');
      setBusy(false);
    }
  }

  return <main className="seller-app seller-login">
    <section className="seller-intro" aria-label="Cirne Rotas">
      <Brand />
      <div className="seller-intro-copy"><p className="seller-kicker">CADA PARADA CONTA</p>
        <h1>Um bom dia <br />começa com <br /><span>uma boa rota.</span></h1>
        <p>Seu roteiro organizado.<br />Mais clareza para o trabalho em campo.</p>
      </div>
      <div className="seller-route-art" aria-hidden="true"><span>01</span><i /><span>02</span><i /><span>03</span></div>
      <p className="seller-intro-foot">CIRNE BATERIAS <span>•</span> OPERAÇÃO EM CAMPO</p>
    </section>
    <section className="seller-login-area" aria-labelledby="login-title">
      <div className="seller-login-form">
        <span className="seller-tag">ACESSO DO VENDEDOR</span>
        <h2 id="login-title">Vamos começar?</h2>
        <p className="seller-muted">Entre com sua conta para ver a rota do dia.</p>
        <form onSubmit={submit} aria-busy={busy}>
          <label htmlFor="email">E-mail</label>
          <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} placeholder="seu.email@empresa.com.br" disabled={busy} />
          <label htmlFor="password">Senha</label>
          <div className="seller-password">
            <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required maxLength={256} placeholder="Sua senha" disabled={busy} />
            <button type="button" onClick={() => setShowPassword(!showPassword)} aria-pressed={showPassword} disabled={busy}>{showPassword ? 'Ocultar' : 'Mostrar'}</button>
          </div>
          {error && <p className="seller-notice seller-error" role="alert">{error}</p>}
          <button className="seller-button seller-primary seller-login-submit" disabled={busy} type="submit">{busy ? 'Entrando…' : 'Entrar e ver minha rota'} <span aria-hidden="true">→</span></button>
        </form>
        <details className="seller-help"><summary>Precisa de ajuda para entrar?</summary><p>Peça ao administrador a liberação do seu acesso ou a redefinição da senha. Esta demonstração não envia e-mails de recuperação.</p></details>
        <p className="seller-online-note"><span aria-hidden="true">◉</span> Conecte-se à internet para entrar e carregar sua rota.</p>
      </div>
      <p className="seller-login-foot">Cirne Rotas <span>Primeira experiência do MVP</span></p>
    </section>
  </main>;
}
