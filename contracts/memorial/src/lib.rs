//! REST IN PUMP Memorial NFTs.
//!
//! A standard NEP-171 NFT contract (core, approvals, enumeration, metadata) with one custom rule:
//! the game server's minter account mints at most ONE memorial per (grave, receiving wallet).
//! Token ids are `<grave_id>-<serial>`, the serial counting memorials of that grave (Memorial #001, #002, …).
//!
//! The artwork and attributes evolve with the grave: token `media` / `reference` are paths under the
//! contract's `base_uri`, served by the game, so every memorial of a grave changes together.
//! There is no payment, staking, yield or burning logic in this contract.

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::{LazyOption, LookupMap};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, Promise, PromiseOrValue};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NonFungibleToken,
    Metadata,
    TokenMetadata,
    Enumeration,
    Approval,
    Memorials,
    GraveCounts,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    /// Account allowed to change settings (the treasury / project owner).
    owner_id: AccountId,
    /// Account the game server uses to mint memorials.
    minter_id: AccountId,
    /// "<grave_id>:<account_id>" -> token id: enforces one memorial per wallet per grave, forever
    /// (even if the token is later transferred away).
    memorials: LookupMap<String, TokenId>,
    /// grave id -> number of memorials minted for it.
    grave_counts: LookupMap<u64, u64>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, minter_id: AccountId, base_uri: String) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Rest In Pump Memorials".to_string(),
            symbol: "RIPM".to_string(),
            icon: None,
            base_uri: Some(base_uri),
            reference: None,
            reference_hash: None,
        };
        metadata.assert_valid();
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NonFungibleToken,
                owner_id.clone(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approval),
            ),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            owner_id,
            minter_id,
            memorials: LookupMap::new(StorageKey::Memorials),
            grave_counts: LookupMap::new(StorageKey::GraveCounts),
        }
    }

    /// Mints the memorial of `receiver_id` for `grave_id`. Minter only; panics if that wallet already got one.
    /// Storage is paid from the contract's own balance, so no deposit is needed.
    /// The title is "<name_prefix> Memorial #NNN" (e.g. "$RUG Memorial #001"); `media` and `reference`
    /// are paths under `base_uri` that the game serves and keeps up to date as the grave evolves.
    pub fn mint_memorial(&mut self, grave_id: u64, receiver_id: AccountId, name_prefix: String, description: String) -> Token {
        require!(env::predecessor_account_id() == self.minter_id, "Only the minter can mint memorials");
        require!(name_prefix.len() <= 80 && description.len() <= 1000, "Name or description too long");
        let key = memorial_key(grave_id, &receiver_id);
        require!(self.memorials.get(&key).is_none(), "This account already has a memorial for this grave");

        let serial = self.grave_counts.get(&grave_id).unwrap_or(0) + 1;
        self.grave_counts.insert(&grave_id, &serial);
        let token_id: TokenId = format!("{grave_id}-{serial}");
        self.memorials.insert(&key, &token_id);

        let now = env::block_timestamp_ms().to_string();
        let metadata = TokenMetadata {
            title: Some(format!("{name_prefix} Memorial #{serial:03}")),
            description: Some(description),
            media: Some(format!("grave/{grave_id}/media.svg")),
            media_hash: None,
            copies: None,
            issued_at: Some(now.clone()),
            expires_at: None,
            starts_at: None,
            updated_at: Some(now),
            extra: Some(format!("{{\"grave_id\":{grave_id},\"serial\":{serial}}}")),
            reference: Some(format!("token/{token_id}.json")),
            reference_hash: None,
        };
        let token = self.tokens.internal_mint_with_refund(token_id, receiver_id, Some(metadata), None);
        // the standard nft_mint event, so wallets and indexers discover the memorial
        NftMint { owner_id: &token.owner_id, token_ids: &[&token.token_id], memo: None }.emit();
        token
    }

    /// The memorial token id originally minted to `account_id` for `grave_id`, if any.
    pub fn memorial_of(&self, grave_id: u64, account_id: AccountId) -> Option<TokenId> {
        self.memorials.get(&memorial_key(grave_id, &account_id))
    }

    /// How many memorials exist for a grave.
    pub fn memorial_count(&self, grave_id: u64) -> u64 {
        self.grave_counts.get(&grave_id).unwrap_or(0)
    }

    pub fn get_minter(&self) -> AccountId {
        self.minter_id.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    /// Owner only: change the account the game server mints with (e.g. key rotation).
    pub fn set_minter(&mut self, minter_id: AccountId) {
        self.assert_owner();
        self.minter_id = minter_id;
    }

    /// Owner only: move the artwork/metadata host (e.g. a new domain). All memorials follow.
    pub fn set_base_uri(&mut self, base_uri: String) {
        self.assert_owner();
        let mut m = self.metadata.get().expect("metadata");
        m.base_uri = Some(base_uri);
        self.metadata.set(&m);
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Owner only");
    }
}

fn memorial_key(grave_id: u64, account_id: &AccountId) -> String {
    format!("{grave_id}:{account_id}")
}

// ------------------------------------------------------------------ NEP-171 standard interfaces

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenApproval for Contract {
    #[payable]
    fn nft_approve(&mut self, token_id: TokenId, account_id: AccountId, msg: Option<String>) -> Option<Promise> {
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id);
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id);
    }

    fn nft_is_approved(&self, token_id: TokenId, approved_account_id: AccountId, approval_id: Option<u64>) -> bool {
        self.tokens.nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().expect("metadata")
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn ctx(predecessor: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id("memorial.whatthehoot.near".parse().unwrap())
            .predecessor_account_id(predecessor)
            .account_balance(NearToken::from_near(50));
        b
    }
    fn owner() -> AccountId { "whatthehoot.near".parse().unwrap() }
    fn minter() -> AccountId { "minter.whatthehoot.near".parse().unwrap() }
    fn setup() -> Contract {
        testing_env!(ctx(owner()).build());
        Contract::new(owner(), minter(), "https://restinpump.example/nft".to_string())
    }
    fn mint(c: &mut Contract, grave: u64, to: AccountId) -> Token {
        testing_env!(ctx(minter()).build());
        c.mint_memorial(grave, to, "$RUG".into(), "desc".into())
    }

    #[test]
    fn minter_mints_numbered_memorials_per_grave() {
        let mut c = setup();
        let a = mint(&mut c, 7, accounts(1));
        let b = mint(&mut c, 7, accounts(2));
        let other = mint(&mut c, 9, accounts(1));
        assert_eq!(a.token_id, "7-1");
        assert_eq!(b.token_id, "7-2");
        assert_eq!(other.token_id, "9-1");
        assert_eq!(a.owner_id, accounts(1));
        assert_eq!(c.memorial_count(7), 2);
        assert_eq!(c.memorial_of(7, accounts(2)), Some("7-2".to_string()));
        assert_eq!(c.memorial_of(9, accounts(2)), None);
        assert_eq!(c.nft_total_supply(), U128(3));
        let meta = c.nft_token("7-1".into()).unwrap().metadata.unwrap();
        assert_eq!(meta.title.as_deref(), Some("$RUG Memorial #001"));
        assert_eq!(meta.media.as_deref(), Some("grave/7/media.svg"));
        assert_eq!(meta.reference.as_deref(), Some("token/7-1.json"));
        assert!(meta.extra.unwrap().contains("\"serial\":1"));
    }

    #[test]
    #[should_panic(expected = "already has a memorial for this grave")]
    fn one_memorial_per_wallet_per_grave() {
        let mut c = setup();
        mint(&mut c, 7, accounts(1));
        mint(&mut c, 7, accounts(1));
    }

    #[test]
    #[should_panic(expected = "Only the minter can mint memorials")]
    fn nobody_else_can_mint() {
        let mut c = setup();
        testing_env!(ctx(accounts(3)).build());
        c.mint_memorial(1, accounts(3), "t".into(), "d".into());
    }

    #[test]
    fn transfer_keeps_the_original_minting_record() {
        let mut c = setup();
        mint(&mut c, 7, accounts(1));
        let mut b = ctx(accounts(1));
        b.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(b.build());
        c.nft_transfer(accounts(2), "7-1".into(), None, None);
        assert_eq!(c.nft_token("7-1".into()).unwrap().owner_id, accounts(2));
        // the original participant still can't receive a second fresh memorial for this grave
        assert_eq!(c.memorial_of(7, accounts(1)), Some("7-1".to_string()));
    }

    #[test]
    fn owner_settings() {
        let mut c = setup();
        testing_env!(ctx(owner()).build());
        c.set_base_uri("https://new.example/nft".into());
        c.set_minter(accounts(4));
        assert_eq!(c.nft_metadata().base_uri.as_deref(), Some("https://new.example/nft"));
        assert_eq!(c.get_minter(), accounts(4));
    }

    #[test]
    #[should_panic(expected = "Owner only")]
    fn settings_are_owner_only() {
        let mut c = setup();
        testing_env!(ctx(accounts(3)).build());
        c.set_minter(accounts(3));
    }
}
