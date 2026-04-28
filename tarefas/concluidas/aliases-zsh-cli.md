# Tarefa: Aliases zsh para gh e railway

## Objetivo
Criar aliases no `~/.zshrc` pra acelerar o uso diário do gh e railway, e adicionar 2 aliases via `gh alias set`.

## Critérios
1. Backup do `~/.zshrc` atual pra `~/.zshrc.bak` antes de modificar.
2. Adicionar ao final do `~/.zshrc` o bloco:

```bash
# === Service Hub CLIs ===
alias hubdeploy='cd ~/v8s/service-hub && git push origin main && railway logs --deployment'
alias hublog='cd ~/v8s/service-hub && railway logs'
alias hubstat='cd ~/v8s/service-hub && railway status'
alias hubvars='cd ~/v8s/service-hub && railway variables'
```

3. Rodar: `gh alias set hub 'repo view MatheusMelo2903/service-hub --web'`.
4. Rodar: `gh alias set hubpr 'pr create --fill'`.
5. Recarregar zshrc: `source ~/.zshrc`.
6. Validar com: `alias | grep hub` e `gh alias list`.

## Fluxo
Arquiteto → Matheus aprova → programador → documentador.

Pula auditor e validador.

## Dependência
Requer a tarefa `instalar-gh-railway-cli.md` concluída antes.
