use super::*;

impl BrokerConfig {
    pub(crate) async fn pairing_join_credential(
        &self,
        pairing_id: &str,
        expires_at: u64,
    ) -> Result<BrokerJoinCredential, String> {
        self.auth
            .pairing_join_credential(&self.broker_room_id, pairing_id, expires_at)
            .await
    }

    pub(crate) async fn device_broker_credential(
        &self,
        device_id: &str,
        expires_at: Option<u64>,
    ) -> Result<DeviceBrokerCredential, String> {
        self.auth
            .device_broker_credential(&self.broker_room_id, device_id, expires_at)
            .await
    }

    pub(crate) async fn client_broker_grant(
        &self,
        device_id: &str,
        client_verify_key: &str,
        device_label: Option<String>,
    ) -> Result<Option<ClientBrokerGrant>, String> {
        self.auth
            .client_broker_grant(
                &self.broker_room_id,
                device_id,
                client_verify_key,
                device_label,
            )
            .await
    }

    pub(crate) async fn revoke_device_credential(&self, device_id: &str) -> Result<(), String> {
        self.auth
            .revoke_device_credential(&self.broker_room_id, device_id)
            .await
            .map(|_| ())
    }

    pub(crate) async fn revoke_other_device_credentials(
        &self,
        keep_device_id: &str,
    ) -> Result<(), String> {
        self.auth
            .revoke_other_device_credentials(&self.broker_room_id, keep_device_id)
            .await
            .map(|_| ())
    }
}
