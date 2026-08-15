from __future__ import annotations

import ipaddress
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


SERVER_CERTIFICATE_HOURS = 24
RENEW_BEFORE_HOURS = 2


def get_local_ca_paths() -> tuple[Path, Path]:
    """mkcert가 만든 로컬 CA 인증서와 개인키 경로를 반환한다."""
    ca_root = Path(os.getenv("CAROOT", Path(os.getenv("LOCALAPPDATA", "")) / "mkcert"))
    return ca_root / "rootCA.pem", ca_root / "rootCA-key.pem"


def read_certificate_expiry(path: Path) -> datetime | None:
    if not path.is_file():
        return None
    certificate = x509.load_pem_x509_certificate(path.read_bytes())
    return certificate.not_valid_after_utc


def issue_short_lived_server_certificate(
    ip_address: str,
    certificate_path: Path,
    private_key_path: Path,
    validity_hours: int = SERVER_CERTIFICATE_HOURS,
) -> datetime:
    """기존 로컬 CA로 현재 IP용 단기 HTTPS 서버 인증서를 발급한다."""
    ca_certificate_path, ca_key_path = get_local_ca_paths()
    if not ca_certificate_path.is_file() or not ca_key_path.is_file():
        raise RuntimeError("로컬 HTTPS 인증기관이 없습니다. HTTPS 필수 설정을 먼저 실행하세요.")

    ca_certificate = x509.load_pem_x509_certificate(ca_certificate_path.read_bytes())
    ca_private_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
    server_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(UTC)
    expires_at = now + timedelta(hours=validity_hours)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Smart Titration Local Server")])
    alternative_names: list[x509.GeneralName] = [x509.DNSName("localhost")]
    for address in (ip_address, "127.0.0.1", "::1"):
        alternative_names.append(x509.IPAddress(ipaddress.ip_address(address)))

    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_certificate.subject)
        .public_key(server_private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(expires_at)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName(alternative_names), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=None,
                decipher_only=None,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(server_private_key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_private_key.public_key()), critical=False)
        .sign(ca_private_key, hashes.SHA256())
    )

    certificate_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_certificate = certificate_path.with_suffix(".pem.tmp")
    temporary_key = private_key_path.with_suffix(".pem.tmp")
    temporary_certificate.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    temporary_key.write_bytes(
        server_private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    temporary_certificate.replace(certificate_path)
    temporary_key.replace(private_key_path)
    return certificate.not_valid_after_utc


def ensure_short_lived_server_certificate(
    ip_address: str,
    certificate_path: Path,
    private_key_path: Path,
) -> tuple[bool, datetime | None]:
    """인증서가 장기 인증서이거나 2시간 이내 만료되면 자동 재발급한다."""
    ca_certificate_path, ca_key_path = get_local_ca_paths()
    if not ca_certificate_path.is_file() or not ca_key_path.is_file():
        return False, None

    should_issue = not certificate_path.is_file() or not private_key_path.is_file()
    current_expiry: datetime | None = None
    if not should_issue:
        try:
            certificate = x509.load_pem_x509_certificate(certificate_path.read_bytes())
            current_expiry = certificate.not_valid_after_utc
            lifetime = certificate.not_valid_after_utc - certificate.not_valid_before_utc
            remaining = current_expiry - datetime.now(UTC)
            names = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            ip_names = {str(value) for value in names.get_values_for_type(x509.IPAddress)}
            should_issue = (
                lifetime > timedelta(hours=SERVER_CERTIFICATE_HOURS + 1)
                or remaining <= timedelta(hours=RENEW_BEFORE_HOURS)
                or ip_address not in ip_names
            )
        except (OSError, ValueError, x509.ExtensionNotFound):
            should_issue = True

    if should_issue:
        current_expiry = issue_short_lived_server_certificate(
            ip_address, certificate_path, private_key_path
        )
        return True, current_expiry
    return False, current_expiry