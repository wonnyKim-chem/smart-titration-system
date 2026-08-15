from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from certificate_manager import (
    ensure_short_lived_server_certificate,
    issue_short_lived_server_certificate,
)


def create_test_ca(directory: Path) -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(UTC)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Local CA")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(private_key, hashes.SHA256())
    )
    directory.mkdir(parents=True)
    (directory / "rootCA.pem").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    (directory / "rootCA-key.pem").write_bytes(
        private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )


def test_server_certificate_is_valid_for_24_hours_and_reused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ca_directory = tmp_path / "ca"
    create_test_ca(ca_directory)
    monkeypatch.setenv("CAROOT", str(ca_directory))
    certificate_path = tmp_path / "certs" / "titration.pem"
    private_key_path = tmp_path / "certs" / "titration-key.pem"

    renewed, expires_at = ensure_short_lived_server_certificate(
        "192.168.10.20", certificate_path, private_key_path
    )

    certificate = x509.load_pem_x509_certificate(certificate_path.read_bytes())
    lifetime = certificate.not_valid_after_utc - certificate.not_valid_before_utc
    ip_names = {
        str(value)
        for value in certificate.extensions.get_extension_for_class(
            x509.SubjectAlternativeName
        ).value.get_values_for_type(x509.IPAddress)
    }
    assert renewed
    assert expires_at is not None
    assert timedelta(hours=24) <= lifetime <= timedelta(hours=24, minutes=6)
    assert "192.168.10.20" in ip_names
    assert private_key_path.is_file()

    renewed_again, same_expiry = ensure_short_lived_server_certificate(
        "192.168.10.20", certificate_path, private_key_path
    )

    assert not renewed_again
    assert same_expiry == expires_at


def test_two_hour_renewal_only_happens_when_enabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ca_directory = tmp_path / "ca"
    create_test_ca(ca_directory)
    monkeypatch.setenv("CAROOT", str(ca_directory))
    certificate_path = tmp_path / "certs" / "titration.pem"
    private_key_path = tmp_path / "certs" / "titration-key.pem"
    issue_short_lived_server_certificate(
        "192.168.10.20", certificate_path, private_key_path, validity_hours=1
    )

    renewed_when_off, _ = ensure_short_lived_server_certificate(
        "192.168.10.20",
        certificate_path,
        private_key_path,
        renew_before_hours=0,
    )
    renewed_when_on, expiry = ensure_short_lived_server_certificate(
        "192.168.10.20",
        certificate_path,
        private_key_path,
        renew_before_hours=2,
    )

    assert not renewed_when_off
    assert renewed_when_on
    assert expiry is not None
    assert expiry - datetime.now(UTC) > timedelta(hours=23)