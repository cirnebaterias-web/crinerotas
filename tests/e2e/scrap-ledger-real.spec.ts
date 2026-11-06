import { readFile } from 'node:fs/promises';
import { expect,test } from '@playwright/test';

test('manager sees the real scrap ledger generation and both analytical views',async({page})=>{
 const manifest=JSON.parse(await readFile('.local/identity-actors.json','utf8')) as {actors:{manager_a:{email:string;password:string}}};
 await page.goto('/login');await page.getByLabel('E-mail',{exact:true}).fill(manifest.actors.manager_a.email);await page.getByLabel('Senha',{exact:true}).fill(manifest.actors.manager_a.password);await page.getByRole('button',{name:'Entrar',exact:true}).click();await expect(page).not.toHaveURL(/\/login$/);
 await page.goto('/management/scrap');
 await expect(page.getByRole('heading',{name:'Conta-corrente de sucata'})).toBeVisible();
 await expect(page.getByText(/20558 movimentos · 717 saldos/)).toBeVisible();
 await expect(page.getByRole('button',{name:'Atualizar agora'})).toBeEnabled();
 await expect(page.getByRole('columnheader',{name:'Saldo (kg)'})).toBeVisible();
 await page.getByRole('button',{name:'Sucatas · histórico'}).click();
 await expect(page.getByRole('columnheader',{name:'Operação'})).toBeVisible();
 await expect(page.getByText('Crédito',{exact:true}).first()).toBeVisible();
});
