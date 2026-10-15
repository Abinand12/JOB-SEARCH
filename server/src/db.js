import { createClient } from '@supabase/supabase-js';

const RESUME_BUCKET = 'resumes';
const PAGE = 1000; // Supabase caps a single select at 1000 rows

export function createDb({ url, serviceRoleKey }) {
  const supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const check = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    supabase,

    async userFromAccessToken(token) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) return null;
      return { id: data.user.id, email: data.user.email };
    },

    // --- extension tokens -------------------------------------------------
    async userIdForTokenHash(tokenHash) {
      const row = check(
        await supabase.from('extension_tokens').select('id, user_id').eq('token_hash', tokenHash).maybeSingle(),
      );
      if (!row) return null;
      await supabase.from('extension_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', row.id);
      return row.user_id;
    },
    async listTokens(userId) {
      return check(
        await supabase
          .from('extension_tokens')
          .select('id, label, created_at, last_used_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false }),
      );
    },
    async createToken(userId, tokenHash, label) {
      return check(
        await supabase
          .from('extension_tokens')
          .insert({ user_id: userId, token_hash: tokenHash, label })
          .select('id, label, created_at')
          .single(),
      );
    },
    async deleteToken(userId, id) {
      check(await supabase.from('extension_tokens').delete().eq('user_id', userId).eq('id', id));
    },

    // --- profile ------------------------------------------------------------
    async getProfile(userId) {
      return check(await supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle());
    },
    async upsertProfile(userId, patch) {
      return check(
        await supabase
          .from('profiles')
          .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
          .select('*')
          .single(),
      );
    },
    async uploadResume(userId, buffer, { filename, mimeType }) {
      const path = `${userId}/resume${mimeType === 'application/pdf' ? '.pdf' : ''}`;
      const { error } = await supabase.storage
        .from(RESUME_BUCKET)
        .upload(path, buffer, { contentType: mimeType, upsert: true });
      if (error) throw new Error(`Resume upload failed: ${error.message}`);
      return { path, filename };
    },
    async downloadResume(path) {
      const { data, error } = await supabase.storage.from(RESUME_BUCKET).download(path);
      if (error) throw new Error(`Resume download failed: ${error.message}`);
      return Buffer.from(await data.arrayBuffer());
    },

    // --- applications -------------------------------------------------------
    async upsertApplication(userId, app) {
      return check(
        await supabase
          .from('applications')
          .upsert({ ...app, user_id: userId, updated_at: new Date().toISOString() }, { onConflict: 'user_id,job_url' })
          .select('*')
          .single(),
      );
    },
    async updateApplication(userId, id, patch) {
      return check(
        await supabase
          .from('applications')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('id', id)
          .select('*')
          .maybeSingle(),
      );
    },
    async findApplicationByUrl(userId, jobUrl) {
      return check(
        await supabase.from('applications').select('*').eq('user_id', userId).eq('job_url', jobUrl).maybeSingle(),
      );
    },
    async listApplications(userId, { status, method, q, limit = 50, offset = 0 } = {}) {
      let query = supabase
        .from('applications')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('started_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (status) query = query.eq('status', status);
      if (method) query = query.eq('method', method);
      if (q) {
        const term = q.replace(/[%,()]/g, ' ').trim();
        if (term) query = query.or(`job_title.ilike.%${term}%,company.ilike.%${term}%`);
      }
      const { data, error, count } = await query;
      if (error) throw new Error(error.message);
      return { rows: data, total: count ?? 0 };
    },
    async applicationsSince(userId, sinceIso) {
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        const page = check(
          await supabase
            .from('applications')
            .select('status, method, ats, company, started_at, submitted_at, questions_answered, llm_answers')
            .eq('user_id', userId)
            .gte('started_at', sinceIso)
            .order('started_at', { ascending: true })
            .range(from, from + PAGE - 1),
        );
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
    },
    async countSubmittedSince(userId, sinceIso) {
      const { count, error } = await supabase
        .from('applications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', 'submitted')
        .gte('submitted_at', sinceIso);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },

    // --- verification alerts -------------------------------------------------
    async createAlert(userId, alert) {
      return check(
        await supabase
          .from('verification_alerts')
          .insert({ ...alert, user_id: userId })
          .select('*')
          .single(),
      );
    },
    async updateAlert(userId, id, patch) {
      return check(
        await supabase
          .from('verification_alerts')
          .update(patch)
          .eq('user_id', userId)
          .eq('id', id)
          .select('*')
          .maybeSingle(),
      );
    },
    async listAlerts(userId, { status } = {}) {
      let query = supabase
        .from('verification_alerts')
        .select('*, applications(job_title, company)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (status) query = query.eq('status', status);
      return check(await query);
    },

    // --- saved question answers ---------------------------------------------
    async savedAnswers(userId) {
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        const page = check(
          await supabase
            .from('question_answers')
            .select('*')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false })
            .range(from, from + PAGE - 1),
        );
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
    },
    async insertSavedAnswers(userId, items) {
      if (!items.length) return;
      // ignoreDuplicates: never overwrite an answer the user already corrected.
      check(
        await supabase
          .from('question_answers')
          .upsert(
            items.map((i) => ({ ...i, user_id: userId, source: 'llm', needs_review: true })),
            { onConflict: 'user_id,question_key', ignoreDuplicates: true },
          ),
      );
    },
    async updateSavedAnswer(userId, id, patch) {
      return check(
        await supabase
          .from('question_answers')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('id', id)
          .select('*')
          .maybeSingle(),
      );
    },
    async deleteSavedAnswer(userId, id) {
      check(await supabase.from('question_answers').delete().eq('user_id', userId).eq('id', id));
    },

    // --- LLM usage ------------------------------------------------------------
    async logUsage(userId, entry) {
      const { error } = await supabase.from('llm_usage').insert({ ...entry, user_id: userId });
      if (error) console.warn('Failed to log LLM usage:', error.message);
    },
    async usageSince(userId, sinceIso) {
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        const page = check(
          await supabase
            .from('llm_usage')
            .select('input_tokens, output_tokens')
            .eq('user_id', userId)
            .gte('created_at', sinceIso)
            .range(from, from + PAGE - 1),
        );
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
    },
  };
}
