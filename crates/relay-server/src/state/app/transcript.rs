use super::*;

impl AppState {
    pub async fn read_thread_transcript(
        &self,
        input: ReadThreadTranscriptInput,
    ) -> Result<ThreadTranscriptResponse, String> {
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            if relay.active_thread_id.as_deref() == Some(input.thread_id.as_str()) {
                ensure_path_within_device_scope(
                    &relay.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                let transcript = relay
                    .transcript
                    .iter()
                    .map(|entry| entry.to_view())
                    .collect::<Vec<_>>();
                let revision = relay.transcript_revision();

                if input.before.is_some() {
                    return Ok(ThreadTranscriptResponse::from_transcript_before(
                        input.thread_id,
                        transcript,
                        input.before,
                        revision,
                    ));
                }

                return Ok(ThreadTranscriptResponse::from_transcript_tail(
                    input.thread_id,
                    transcript,
                    revision,
                ));
            }
        }

        let thread_data = self
            .find_thread_provider(&input.thread_id)
            .await?
            .1
            .read_thread(&input.thread_id)
            .await?;
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(
                &thread_data.thread.cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
        }

        if input.before.is_some() {
            return Ok(ThreadTranscriptResponse::from_transcript_before(
                input.thread_id,
                thread_data.transcript,
                input.before,
                0,
            ));
        }

        Ok(ThreadTranscriptResponse::from_transcript_tail(
            input.thread_id,
            thread_data.transcript,
            0,
        ))
    }

    pub async fn read_thread_entries(
        &self,
        input: ReadThreadEntriesInput,
    ) -> Result<ThreadEntriesResponse, String> {
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            if relay.active_thread_id.as_deref() == Some(input.thread_id.as_str()) {
                ensure_path_within_device_scope(
                    &relay.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                let transcript = relay
                    .transcript
                    .iter()
                    .map(|entry| entry.to_view())
                    .collect::<Vec<_>>();

                return Ok(ThreadEntriesResponse::from_item_ids(
                    input.thread_id,
                    transcript,
                    input.item_ids,
                ));
            }
        }

        let thread_data = self
            .find_thread_provider(&input.thread_id)
            .await?
            .1
            .read_thread(&input.thread_id)
            .await?;
        {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            ensure_path_within_device_scope(
                &thread_data.thread.cwd,
                &device_scope,
                &relay.allowed_roots,
            )?;
        }

        Ok(ThreadEntriesResponse::from_item_ids(
            input.thread_id,
            thread_data.transcript,
            input.item_ids,
        ))
    }

    pub async fn read_thread_entry_detail(
        &self,
        input: ReadThreadEntryDetailInput,
    ) -> Result<ThreadEntryDetailResponse, String> {
        let relay_entry = {
            let relay = self.relay.read().await;
            let device_scope = input
                .device_id
                .as_deref()
                .map(|id| relay.device_path_scope(id))
                .unwrap_or_default();
            if relay.active_thread_id.as_deref() == Some(input.thread_id.as_str()) {
                ensure_path_within_device_scope(
                    &relay.current_cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
                relay
                    .transcript
                    .iter()
                    .find(|entry| entry.item_id == input.item_id)
                    .filter(|entry| entry.kind != crate::protocol::TranscriptEntryKind::ToolCall)
                    .map(|entry| entry.to_view())
            } else {
                None
            }
        };

        let entry = if let Some(entry) = relay_entry {
            entry
        } else {
            let thread_data = self
                .find_thread_provider(&input.thread_id)
                .await?
                .1
                .read_thread(&input.thread_id)
                .await?;
            {
                let relay = self.relay.read().await;
                let device_scope = input
                    .device_id
                    .as_deref()
                    .map(|id| relay.device_path_scope(id))
                    .unwrap_or_default();
                ensure_path_within_device_scope(
                    &thread_data.thread.cwd,
                    &device_scope,
                    &relay.allowed_roots,
                )?;
            }

            self.find_thread_provider(&input.thread_id)
                .await?
                .1
                .read_thread_entry_detail(&input.thread_id, &input.item_id)
                .await?
                .ok_or_else(|| {
                    format!(
                        "thread entry `{}` was not found in thread `{}`",
                        input.item_id, input.thread_id
                    )
                })?
        };

        if let Some(field) = input.field.as_deref() {
            return ThreadEntryDetailResponse::from_entry_chunk(
                input.thread_id,
                &entry,
                field,
                input.cursor.unwrap_or_default(),
            );
        }

        ThreadEntryDetailResponse::from_entry(input.thread_id, entry)
    }
}
